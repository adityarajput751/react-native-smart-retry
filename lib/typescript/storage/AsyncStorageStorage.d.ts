import type { QueuedRequest } from '../types';
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
export declare class AsyncStorageStorage implements QueueStorage {
    private readonly storage;
    private writeChain;
    constructor(storage: AsyncStorageLike);
    add(request: QueuedRequest): Promise<void>;
    getAll(): Promise<QueuedRequest[]>;
    get(id: string): Promise<QueuedRequest | null>;
    update(id: string, data: Partial<QueuedRequest>): Promise<void>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    private readIndex;
    private writeIndex;
    private safeParse;
    private isQueuedRequest;
    private runExclusive;
}
//# sourceMappingURL=AsyncStorageStorage.d.ts.map