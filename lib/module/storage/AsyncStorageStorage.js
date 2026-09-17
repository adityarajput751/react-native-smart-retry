import { logger } from '../utils/logger';

/**
 * The subset of the AsyncStorage API this implementation depends on. Matches
 * `@react-native-async-storage/async-storage`'s default export, so the real
 * module (or any drop-in compatible storage) can be passed in directly.
 */

const INDEX_KEY = '@react-native-smart-retry/queue-index';
const ITEM_KEY_PREFIX = '@react-native-smart-retry/queue-item/';
function itemKey(id) {
  return `${ITEM_KEY_PREFIX}${id}`;
}

/**
 * AsyncStorage-backed implementation of {@link QueueStorage}. Stores each
 * queued request under its own key plus a small index of ids, rather than one
 * large JSON blob, so a write to one request cannot corrupt the others.
 *
 * Writes are serialized through an internal promise chain (`runExclusive`)
 * because AsyncStorage provides no transactions — without this, concurrent
 * `add`/`remove` calls could race on the shared index array.
 */
export class AsyncStorageStorage {
  writeChain = Promise.resolve();
  constructor(storage) {
    this.storage = storage;
  }
  async add(request) {
    await this.runExclusive(async () => {
      const index = await this.readIndex();
      if (!index.includes(request.id)) {
        index.push(request.id);
        await this.writeIndex(index);
      }
      await this.storage.setItem(itemKey(request.id), JSON.stringify(request));
    });
  }
  async getAll() {
    const index = await this.readIndex();
    if (index.length === 0) {
      return [];
    }
    const keys = index.map(itemKey);
    const pairs = this.storage.multiGet ? await this.storage.multiGet(keys) : await Promise.all(keys.map(async key => [key, await this.storage.getItem(key)]));
    const results = [];
    const staleIds = [];
    for (let i = 0; i < index.length; i++) {
      const id = index[i];
      const raw = pairs[i]?.[1];
      if (raw == null) {
        staleIds.push(id);
        continue;
      }
      const parsed = this.safeParse(id, raw);
      if (parsed) {
        results.push(parsed);
      } else {
        staleIds.push(id);
      }
    }
    if (staleIds.length > 0) {
      await this.runExclusive(async () => {
        const current = await this.readIndex();
        const cleaned = current.filter(id => !staleIds.includes(id));
        await this.writeIndex(cleaned);
      });
    }
    return results;
  }
  async get(id) {
    const raw = await this.storage.getItem(itemKey(id));
    if (raw == null) {
      return null;
    }
    return this.safeParse(id, raw);
  }
  async update(id, data) {
    await this.runExclusive(async () => {
      const raw = await this.storage.getItem(itemKey(id));
      if (raw == null) {
        return;
      }
      const existing = this.safeParse(id, raw);
      if (!existing) {
        return;
      }
      const merged = {
        ...existing,
        ...data,
        id: existing.id
      };
      await this.storage.setItem(itemKey(id), JSON.stringify(merged));
    });
  }
  async remove(id) {
    await this.runExclusive(async () => {
      await this.storage.removeItem(itemKey(id));
      const index = await this.readIndex();
      const next = index.filter(existingId => existingId !== id);
      if (next.length !== index.length) {
        await this.writeIndex(next);
      }
    });
  }
  async clear() {
    await this.runExclusive(async () => {
      const index = await this.readIndex();
      const keys = index.map(itemKey);
      if (keys.length > 0) {
        if (this.storage.multiRemove) {
          await this.storage.multiRemove(keys);
        } else {
          await Promise.all(keys.map(key => this.storage.removeItem(key)));
        }
      }
      await this.storage.removeItem(INDEX_KEY);
    });
  }
  async readIndex() {
    const raw = await this.storage.getItem(INDEX_KEY);
    if (raw == null) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(entry => typeof entry === 'string');
      }
      logger.warn('Queue index was corrupted (not an array); resetting to empty.');
      return [];
    } catch (error) {
      logger.warn('Failed to parse queue index; resetting to empty.', error);
      return [];
    }
  }
  async writeIndex(index) {
    await this.storage.setItem(INDEX_KEY, JSON.stringify(index));
  }
  safeParse(id, raw) {
    try {
      const parsed = JSON.parse(raw);
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
  isQueuedRequest(value) {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value;
    return typeof record.id === 'string' && typeof record.url === 'string' && typeof record.method === 'string' && typeof record.status === 'string';
  }
  runExclusive(fn) {
    const run = this.writeChain.then(fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
//# sourceMappingURL=AsyncStorageStorage.js.map