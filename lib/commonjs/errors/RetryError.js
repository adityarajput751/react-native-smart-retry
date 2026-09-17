"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RetryError = void 0;
/**
 * Wraps a lower-level error (network failure, HTTP error response, timeout,
 * abort) with the classification metadata SmartRetry needs to decide whether
 * to retry, queue, or fail permanently.
 */
class RetryError extends Error {
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
exports.RetryError = RetryError;
//# sourceMappingURL=RetryError.js.map