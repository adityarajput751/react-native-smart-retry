import type { QueuedRequest, SmartRetryRequestOptions } from '../types';
/** Builds a fresh {@link QueuedRequest} record from request options. */
export declare function createQueueItem(options: SmartRetryRequestOptions): QueuedRequest;
/** Sorts requests oldest-first, so FIFO processing order is always by creation time. */
export declare function sortByCreatedAt(requests: QueuedRequest[]): QueuedRequest[];
//# sourceMappingURL=QueueItem.d.ts.map