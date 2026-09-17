import type { QueuedRequest } from '../types';
/**
 * Storage abstraction for the persistent request queue. Implementations must
 * never silently discard malformed records — corrupted entries should be
 * surfaced (e.g. via logging) and skipped individually rather than wiping the
 * whole queue.
 */
export interface QueueStorage {
    /** Persists a new queued request. */
    add(request: QueuedRequest): Promise<void>;
    /** Returns all queued requests currently in storage, in no particular order. */
    getAll(): Promise<QueuedRequest[]>;
    /** Returns a single queued request by id, or null if it does not exist. */
    get(id: string): Promise<QueuedRequest | null>;
    /** Merges `data` into the existing record for `id`. No-op if the id does not exist. */
    update(id: string, data: Partial<QueuedRequest>): Promise<void>;
    /** Removes a queued request by id. No-op if it does not exist. */
    remove(id: string): Promise<void>;
    /** Removes all queued requests. */
    clear(): Promise<void>;
}
//# sourceMappingURL=QueueStorage.d.ts.map