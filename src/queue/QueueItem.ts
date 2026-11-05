import { generateRequestId } from '../utils/id';
import type { QueuedRequest, SmartRetryRequestOptions } from '../types';

/** Builds a fresh {@link QueuedRequest} record from request options. */
export function createQueueItem(
  options: SmartRetryRequestOptions,
  initial?: Pick<QueuedRequest, 'lastError' | 'nextAttemptAt'>
): QueuedRequest {
  const now = Date.now();
  return {
    id: generateRequestId(),
    url: options.url,
    method: options.method,
    headers: options.headers,
    data: options.data,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    status: 'pending',
    uniqueKey: options.uniqueKey,
    idempotencyKey: options.idempotencyKey,
    timeout: options.timeout,
    maxRetries: options.retries,
    retryOnStatusCodes: options.retryOnStatusCodes,
    strategy: options.strategy,
    baseDelay: options.baseDelay,
    maxDelay: options.maxDelay,
    lastError: initial?.lastError,
    nextAttemptAt: initial?.nextAttemptAt,
  };
}

/** Sorts requests oldest-first, so FIFO processing order is always by creation time. */
export function sortByCreatedAt(requests: QueuedRequest[]): QueuedRequest[] {
  return [...requests].sort((a, b) => a.createdAt - b.createdAt);
}
