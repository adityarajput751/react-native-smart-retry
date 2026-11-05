import { calculateDelay } from '../src/retry/calculateDelay';
import { isMethodRetryable } from '../src/retry/RetryPolicy';
import { RetryEngine } from '../src/retry/RetryEngine';
import { RetryError } from '../src/errors/RetryError';
import type { RetryPolicy } from '../src/retry/RetryPolicy';

describe('calculateDelay', () => {
  it('returns a constant delay for the fixed strategy', () => {
    expect(calculateDelay({ attempt: 1, strategy: 'fixed', baseDelay: 1000, maxDelay: 30000 })).toBe(1000);
    expect(calculateDelay({ attempt: 5, strategy: 'fixed', baseDelay: 1000, maxDelay: 30000 })).toBe(1000);
  });

  it('scales linearly with attempt number', () => {
    expect(calculateDelay({ attempt: 3, strategy: 'linear', baseDelay: 1000, maxDelay: 30000 })).toBe(3000);
  });

  it('doubles per attempt for exponential strategy', () => {
    expect(calculateDelay({ attempt: 1, strategy: 'exponential', baseDelay: 1000, maxDelay: 30000 })).toBe(
      1000
    );
    expect(calculateDelay({ attempt: 2, strategy: 'exponential', baseDelay: 1000, maxDelay: 30000 })).toBe(
      2000
    );
    expect(calculateDelay({ attempt: 4, strategy: 'exponential', baseDelay: 1000, maxDelay: 30000 })).toBe(
      8000
    );
  });

  it('never exceeds maxDelay', () => {
    const delay = calculateDelay({ attempt: 10, strategy: 'exponential', baseDelay: 1000, maxDelay: 5000 });
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('applies jitter within 0.8x-1.2x of the exponential value for exponential-jitter', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = calculateDelay({
        attempt,
        strategy: 'exponential-jitter',
        baseDelay: 1000,
        maxDelay: 30000,
      });
      const exponential = 1000 * 2 ** (attempt - 1);
      expect(delay).toBeGreaterThanOrEqual(exponential * 0.8 - 0.01);
      expect(delay).toBeLessThanOrEqual(exponential * 1.2 + 0.01);
    }
  });

  it('prioritizes an explicit retryAfterMs over the strategy, still bounded by maxDelay', () => {
    expect(
      calculateDelay({
        attempt: 1,
        strategy: 'exponential',
        baseDelay: 1000,
        maxDelay: 30000,
        retryAfterMs: 9000,
      })
    ).toBe(9000);
    expect(
      calculateDelay({
        attempt: 1,
        strategy: 'exponential',
        baseDelay: 1000,
        maxDelay: 5000,
        retryAfterMs: 9000,
      })
    ).toBe(5000);
  });
});

describe('isMethodRetryable', () => {
  it('always allows safe methods', () => {
    expect(isMethodRetryable('GET')).toBe(true);
    expect(isMethodRetryable('HEAD')).toBe(true);
    expect(isMethodRetryable('OPTIONS')).toBe(true);
  });

  it('disallows unsafe methods unless explicitly listed in retryMethods', () => {
    expect(isMethodRetryable('POST')).toBe(false);
    expect(isMethodRetryable('POST', ['POST'])).toBe(true);
    expect(isMethodRetryable('DELETE', ['POST'])).toBe(false);
  });
});

describe('RetryEngine', () => {
  const basePolicy: RetryPolicy = {
    strategy: 'fixed',
    baseDelay: 1,
    maxDelay: 10,
    retries: 3,
  };

  it('returns the result immediately on success without retrying', async () => {
    const engine = new RetryEngine();
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await engine.executeWithRetry(fn, { requestId: 'r1', method: 'GET', policy: basePolicy });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure up to the configured number of retries then throws', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'boom', reason: 'SERVER_ERROR', status: 500 });
    const fn = jest.fn().mockRejectedValue(error);
    const onRetry = jest.fn();

    await expect(
      engine.executeWithRetry(fn, { requestId: 'r1', method: 'GET', policy: basePolicy, onRetry })
    ).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient failure within the retry budget', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'boom', reason: 'NETWORK_ERROR' });
    const fn = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('recovered');

    const result = await engine.executeWithRetry(fn, { requestId: 'r1', method: 'GET', policy: basePolicy });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent CLIENT_ERROR', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'bad request', reason: 'CLIENT_ERROR', status: 400 });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      engine.executeWithRetry(fn, { requestId: 'r1', method: 'POST', policy: basePolicy })
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unsafe method unless explicitly allowed via retryMethods', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'boom', reason: 'SERVER_ERROR', status: 500 });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      engine.executeWithRetry(fn, { requestId: 'r1', method: 'POST', policy: basePolicy })
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries an unsafe method when explicitly allowed via retryMethods', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'boom', reason: 'SERVER_ERROR', status: 500 });
    const fn = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');

    const result = await engine.executeWithRetry(fn, {
      requestId: 'r1',
      method: 'POST',
      policy: { ...basePolicy, retryMethods: ['POST'] },
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects a custom retryOn predicate', async () => {
    const engine = new RetryEngine();
    const error = new RetryError({ message: 'boom', reason: 'UNKNOWN' });
    const fn = jest.fn().mockRejectedValue(error);

    await expect(
      engine.executeWithRetry(fn, {
        requestId: 'r1',
        method: 'GET',
        policy: { ...basePolicy, retryOn: () => false },
      })
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
