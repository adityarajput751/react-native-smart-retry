import type { QueuedRequest } from '../types';
import { logger } from '../utils/logger';
import type { QueueStorage } from './QueueStorage';

/**
 * The subset of the AsyncStorage API this implementation depends on. Matches
 * `@react-native-async-storage/async-storage`'s default export, so the real
 * module (or any drop-in compatible storage) can be passed in directly.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet?(keys: string[]): Promise<readonly [string, string | null][]>;
  multiSet?(keyValuePairs: [string, string][]): Promise<void>;
  multiRemove?(keys: string[]): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
}

const INDEX_KEY = '@react-native-smart-retry/queue-index';
const ITEM_KEY_PREFIX = '@react-native-smart-retry/queue-item/';

function itemKey(id: string): string {
  return `${ITEM_KEY_PREFIX}${id}`;
}

/**
 * AsyncStorage-backed implementation of {@link QueueStorage}. Stores each
 * queued request under its own key plus a small index of ids, rather than one
 * large JSON blob, so a write to one request cannot corrupt the others.
 *
 * Operations are serialized through an internal promise chain (`runExclusive`)
 * because AsyncStorage provides no transactions — without this, concurrent
 * calls could race on the shared index array. Reads of the whole queue go
 * through the same chain, so they always see complete writes.
 */
export class AsyncStorageStorage implements QueueStorage {
  private readonly storage: AsyncStorageLike;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storage: AsyncStorageLike) {
    this.storage = storage;
  }

  async add(request: QueuedRequest): Promise<void> {
    await this.runExclusive(async () => {
      // Item before index: an id in the index must always point at a stored item,
      // otherwise a reader would treat a half-written request as stale and drop it.
      await this.storage.setItem(itemKey(request.id), JSON.stringify(request));
      const index = await this.readIndex();
      if (!index.includes(request.id)) {
        index.push(request.id);
        await this.writeIndex(index);
      }
    });
  }

  getAll(): Promise<QueuedRequest[]> {
    return this.runExclusive(async () => {
      const index = await this.readIndex();
      if (index.length === 0) {
        return [];
      }

      const keys = index.map(itemKey);
      const pairs = this.storage.multiGet
        ? await this.storage.multiGet(keys)
        : await Promise.all(
            keys.map(async (key): Promise<[string, string | null]> => [key, await this.storage.getItem(key)])
          );

      const results: QueuedRequest[] = [];
      const staleIds: string[] = [];

      index.forEach((id, i) => {
        const raw = pairs[i]?.[1];
        const parsed = raw == null ? null : this.safeParse(id, raw);
        if (parsed) {
          results.push(parsed);
        } else {
          staleIds.push(id);
        }
      });

      if (staleIds.length > 0) {
        await this.writeIndex(index.filter((id) => !staleIds.includes(id)));
      }

      return results;
    });
  }

  async get(id: string): Promise<QueuedRequest | null> {
    const raw = await this.storage.getItem(itemKey(id));
    if (raw == null) {
      return null;
    }
    return this.safeParse(id, raw);
  }

  async update(id: string, data: Partial<QueuedRequest>): Promise<void> {
    await this.runExclusive(async () => {
      const raw = await this.storage.getItem(itemKey(id));
      if (raw == null) {
        return;
      }
      const existing = this.safeParse(id, raw);
      if (!existing) {
        return;
      }
      const merged: QueuedRequest = { ...existing, ...data, id: existing.id };
      await this.storage.setItem(itemKey(id), JSON.stringify(merged));
    });
  }

  async remove(id: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.storage.removeItem(itemKey(id));
      const index = await this.readIndex();
      const next = index.filter((existingId) => existingId !== id);
      if (next.length !== index.length) {
        await this.writeIndex(next);
      }
    });
  }

  async clear(): Promise<void> {
    await this.runExclusive(async () => {
      const index = await this.readIndex();
      const keys = index.map(itemKey);
      if (keys.length > 0) {
        if (this.storage.multiRemove) {
          await this.storage.multiRemove(keys);
        } else {
          await Promise.all(keys.map((key) => this.storage.removeItem(key)));
        }
      }
      await this.storage.removeItem(INDEX_KEY);
    });
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.storage.getItem(INDEX_KEY);
    if (raw == null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string');
      }
      logger.warn('Queue index was corrupted (not an array); rebuilding it.');
    } catch (error) {
      logger.warn('Failed to parse queue index; rebuilding it.', error);
    }
    return this.rebuildIndex();
  }

  /** Recovers the ids from the item keys, so a damaged index cannot strand the whole queue. */
  private async rebuildIndex(): Promise<string[]> {
    if (!this.storage.getAllKeys) {
      return [];
    }
    const keys = await this.storage.getAllKeys();
    return keys
      .filter((key) => key.startsWith(ITEM_KEY_PREFIX))
      .map((key) => key.slice(ITEM_KEY_PREFIX.length));
  }

  private async writeIndex(index: string[]): Promise<void> {
    await this.storage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  private safeParse(id: string, raw: string): QueuedRequest | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (this.isQueuedRequest(parsed)) {
        return parsed;
      }
      logger.warn(`Queue item ${id} was malformed and has been skipped.`);
      return null;
    } catch (error) {
      logger.warn(`Queue item ${id} could not be parsed and has been skipped.`, error);
      return null;
    }
  }

  private isQueuedRequest(value: unknown): value is QueuedRequest {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record.id === 'string' &&
      typeof record.url === 'string' &&
      typeof record.method === 'string' &&
      typeof record.status === 'string'
    );
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
