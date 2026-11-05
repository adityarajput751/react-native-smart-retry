import type { RetryReason } from '../types';

/**
 * Wraps a lower-level error (network failure, HTTP error response, timeout,
 * abort) with the classification metadata SmartRetry needs to decide whether
 * to retry, queue, or fail permanently.
 */
export class RetryError extends Error {
  readonly reason: RetryReason;
  readonly status?: number;
  readonly isNetworkError: boolean;
  readonly isTimeout: boolean;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  /** Parsed body of the failed HTTP response, when there was one. */
  readonly data?: unknown;

  constructor(options: {
    message: string;
    reason: RetryReason;
    status?: number;
    isNetworkError?: boolean;
    isTimeout?: boolean;
    cause?: unknown;
    retryAfterMs?: number;
    data?: unknown;
  }) {
    super(options.message);
    this.name = 'RetryError';
    this.reason = options.reason;
    this.status = options.status;
    this.isNetworkError = options.isNetworkError ?? false;
    this.isTimeout = options.isTimeout ?? false;
    this.cause = options.cause;
    this.retryAfterMs = options.retryAfterMs;
    this.data = options.data;
  }
}
