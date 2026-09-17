import type { HttpMethod, RetryStrategy } from '../types';

/** Fully-resolved retry configuration used by the retry engine and queue processor. */
export interface RetryPolicy {
  strategy: RetryStrategy;
  baseDelay: number;
  maxDelay: number;
  retries: number;
  retryOnStatusCodes?: number[];
  retryOn?: (error: unknown) => boolean;
  /** Unsafe methods (POST/PUT/PATCH/DELETE) that are allowed to auto-retry on transient errors. */
  retryMethods?: HttpMethod[];
}

/** Methods considered safe to retry automatically without explicit opt-in. */
export const SAFE_RETRY_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Decides whether a method may be retried after a transient (non-network)
 * error. Safe methods always may; unsafe methods require the caller to have
 * explicitly listed them in `retryMethods` — never retried by default, since
 * a POST/PUT/PATCH/DELETE may have already partially succeeded server-side.
 */
export function isMethodRetryable(method: HttpMethod, retryMethods?: HttpMethod[]): boolean {
  if (SAFE_RETRY_METHODS.includes(method)) {
    return true;
  }
  return retryMethods ? retryMethods.includes(method) : false;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  strategy: 'exponential-jitter',
  baseDelay: 1000,
  maxDelay: 30000,
  retries: 3,
};
