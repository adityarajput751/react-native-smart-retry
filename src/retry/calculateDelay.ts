import type { RetryStrategy } from '../types';

export interface CalculateDelayOptions {
  /** 1-based attempt number. */
  attempt: number;
  strategy: RetryStrategy;
  baseDelay: number;
  maxDelay: number;
  /** When set (e.g. from a `Retry-After` header), takes priority over the strategy calculation. */
  retryAfterMs?: number | null;
}

/**
 * Computes the delay before the next retry attempt. Delay is always clamped
 * to `maxDelay`. When `retryAfterMs` is provided it takes precedence over the
 * strategy (still bounded by `maxDelay`, so a misbehaving server cannot stall
 * the queue indefinitely).
 *
 * exponential-jitter applies a 0.8x-1.2x multiplier on top of the exponential
 * value, e.g. base=1000ms -> ~1000, ~2000, ~4000, ~8000, ~16000 before jitter.
 */
export function calculateDelay(options: CalculateDelayOptions): number {
  const { attempt, strategy, baseDelay, maxDelay, retryAfterMs } = options;

  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.max(0, Math.min(retryAfterMs, maxDelay));
  }

  const safeAttempt = Math.max(1, attempt);
  let delay: number;

  switch (strategy) {
    case 'fixed':
      delay = baseDelay;
      break;
    case 'linear':
      delay = baseDelay * safeAttempt;
      break;
    case 'exponential':
      delay = baseDelay * Math.pow(2, safeAttempt - 1);
      break;
    case 'exponential-jitter':
    default: {
      const exponential = baseDelay * Math.pow(2, safeAttempt - 1);
      const jitterMultiplier = 0.8 + Math.random() * 0.4;
      delay = exponential * jitterMultiplier;
      break;
    }
  }

  return Math.max(0, Math.min(delay, maxDelay));
}
