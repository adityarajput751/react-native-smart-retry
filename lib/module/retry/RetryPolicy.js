/** Fully-resolved retry configuration used by the retry engine and queue processor. */

/** Methods considered safe to retry automatically without explicit opt-in. */
export const SAFE_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Decides whether a method may be retried after a transient (non-network)
 * error. Safe methods always may; unsafe methods require the caller to have
 * explicitly listed them in `retryMethods` — never retried by default, since
 * a POST/PUT/PATCH/DELETE may have already partially succeeded server-side.
 */
export function isMethodRetryable(method, retryMethods) {
  if (SAFE_RETRY_METHODS.includes(method)) {
    return true;
  }
  return retryMethods ? retryMethods.includes(method) : false;
}
export const DEFAULT_RETRY_POLICY = {
  strategy: 'exponential-jitter',
  baseDelay: 1000,
  maxDelay: 30000,
  retries: 3
};
//# sourceMappingURL=RetryPolicy.js.map