/**
 * Wraps a lower-level error (network failure, HTTP error response, timeout,
 * abort) with the classification metadata SmartRetry needs to decide whether
 * to retry, queue, or fail permanently.
 */
export class RetryError extends Error {
  constructor(options) {
    super(options.message);
    this.name = 'RetryError';
    this.reason = options.reason;
    this.status = options.status;
    this.isNetworkError = options.isNetworkError ?? false;
    this.isTimeout = options.isTimeout ?? false;
    this.cause = options.cause;
    this.retryAfterMs = options.retryAfterMs;
  }
}
//# sourceMappingURL=RetryError.js.map