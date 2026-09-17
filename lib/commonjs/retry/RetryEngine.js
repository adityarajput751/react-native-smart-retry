"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RetryEngine = void 0;
var _ErrorClassifier = require("../errors/ErrorClassifier");
var _RetryError = require("../errors/RetryError");
var _sleep = require("../utils/sleep");
var _calculateDelay = require("./calculateDelay");
var _RetryPolicy = require("./RetryPolicy");
/**
 * Generic, in-process retry-with-backoff engine used for immediate (not
 * queued) requests. Retries happen synchronously within a single call to
 * `SmartRetry.request()` — this is distinct from the persistent offline
 * queue, which instead defers a request across app sessions until
 * connectivity returns (see `QueueProcessor`).
 */
class RetryEngine {
  async executeWithRetry(fn, options) {
    const {
      requestId,
      method,
      policy,
      signal,
      onRetry,
      retryConnectivityErrors = true
    } = options;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await fn();
      } catch (rawError) {
        const error = rawError instanceof _RetryError.RetryError ? rawError : this.rethrowUnknown(rawError);
        const isConnectivityError = error.reason === 'NETWORK_ERROR' || error.reason === 'TIMEOUT';
        const methodAllowed = (0, _RetryPolicy.isMethodRetryable)(method, policy.retryMethods);
        const retryable = methodAllowed && (!isConnectivityError || retryConnectivityErrors) && (0, _ErrorClassifier.isRetryable)(error, {
          retryOnStatusCodes: policy.retryOnStatusCodes,
          retryOn: policy.retryOn
        });
        if (!retryable || attempt > policy.retries) {
          throw error;
        }
        const delay = (0, _calculateDelay.calculateDelay)({
          attempt,
          strategy: policy.strategy,
          baseDelay: policy.baseDelay,
          maxDelay: policy.maxDelay,
          retryAfterMs: error.retryAfterMs
        });
        onRetry?.({
          requestId,
          attempt,
          maxRetries: policy.retries,
          reason: error.reason,
          delay
        });
        await (0, _sleep.sleep)(delay, signal);
      }
    }
  }
  rethrowUnknown(error) {
    throw error;
  }
}
exports.RetryEngine = RetryEngine;
//# sourceMappingURL=RetryEngine.js.map