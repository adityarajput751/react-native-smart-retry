import { isRetryable } from '../errors/ErrorClassifier';
import { RetryError } from '../errors/RetryError';
import { sleep } from '../utils/sleep';
import { calculateDelay } from './calculateDelay';
import { isMethodRetryable } from './RetryPolicy';
/**
 * Generic, in-process retry-with-backoff engine used for immediate (not
 * queued) requests. Retries happen synchronously within a single call to
 * `SmartRetry.request()` — this is distinct from the persistent offline
 * queue, which instead defers a request across app sessions until
 * connectivity returns (see `QueueProcessor`).
 */
export class RetryEngine {
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
        const error = rawError instanceof RetryError ? rawError : this.rethrowUnknown(rawError);
        const isConnectivityError = error.reason === 'NETWORK_ERROR' || error.reason === 'TIMEOUT';
        const methodAllowed = isMethodRetryable(method, policy.retryMethods);
        const retryable = methodAllowed && (!isConnectivityError || retryConnectivityErrors) && isRetryable(error, {
          retryOnStatusCodes: policy.retryOnStatusCodes,
          retryOn: policy.retryOn
        });
        if (!retryable || attempt > policy.retries) {
          throw error;
        }
        const delay = calculateDelay({
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
        await sleep(delay, signal);
      }
    }
  }
  rethrowUnknown(error) {
    throw error;
  }
}
//# sourceMappingURL=RetryEngine.js.map