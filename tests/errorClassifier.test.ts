import {
  classifyStatusError,
  classifyThrownError,
  isRetryable,
  parseRetryAfter,
} from '../src/errors/ErrorClassifier';
import { RetryError } from '../src/errors/RetryError';

describe('ErrorClassifier', () => {
  describe('classifyThrownError', () => {
    it('classifies a TypeError network failure as NETWORK_ERROR', () => {
      const error = classifyThrownError(new TypeError('Network request failed'));
      expect(error.reason).toBe('NETWORK_ERROR');
      expect(error.isNetworkError).toBe(true);
    });

    it('classifies an AbortError as ABORTED, not as a retryable timeout', () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const error = classifyThrownError(abortError);
      expect(error.reason).toBe('ABORTED');
      expect(error.isTimeout).toBe(false);
      expect(isRetryable(error, { retryOn: () => true })).toBe(false);
    });

    it('classifies explicit timeout flag as TIMEOUT', () => {
      const error = classifyThrownError(new Error('slow'), { wasTimeout: true });
      expect(error.reason).toBe('TIMEOUT');
      expect(error.isTimeout).toBe(true);
    });

    it('passes through an existing RetryError unchanged', () => {
      const original = new RetryError({ message: 'x', reason: 'UNKNOWN' });
      expect(classifyThrownError(original)).toBe(original);
    });

    it('classifies unrecognized errors as UNKNOWN', () => {
      const error = classifyThrownError(new Error('mystery'));
      expect(error.reason).toBe('UNKNOWN');
    });
  });

  describe('classifyStatusError', () => {
    it.each([400, 401, 403, 404, 422])('classifies %d as CLIENT_ERROR', (status) => {
      const error = classifyStatusError(status);
      expect(error.reason).toBe('CLIENT_ERROR');
      expect(error.status).toBe(status);
    });

    it.each([408, 500, 502, 503, 504])('classifies %d as SERVER_ERROR', (status) => {
      const error = classifyStatusError(status);
      expect(error.reason).toBe('SERVER_ERROR');
    });

    it('classifies 429 as RATE_LIMIT', () => {
      const error = classifyStatusError(429);
      expect(error.reason).toBe('RATE_LIMIT');
    });

    it('respects custom retryOnStatusCodes', () => {
      const error = classifyStatusError(451, { retryOnStatusCodes: [451] });
      expect(error.reason).toBe('SERVER_ERROR');
    });
  });

  describe('isRetryable', () => {
    it('treats NETWORK_ERROR, TIMEOUT, and RATE_LIMIT as retryable by default', () => {
      expect(isRetryable(new RetryError({ message: 'x', reason: 'NETWORK_ERROR' }))).toBe(true);
      expect(isRetryable(new RetryError({ message: 'x', reason: 'TIMEOUT' }))).toBe(true);
      expect(isRetryable(new RetryError({ message: 'x', reason: 'RATE_LIMIT' }))).toBe(true);
    });

    it('treats CLIENT_ERROR as non-retryable by default', () => {
      expect(isRetryable(new RetryError({ message: 'x', reason: 'CLIENT_ERROR', status: 400 }))).toBe(false);
    });

    it('honors default retryable status codes for SERVER_ERROR', () => {
      const retryable = new RetryError({ message: 'x', reason: 'SERVER_ERROR', status: 500 });
      expect(isRetryable(retryable)).toBe(true);
    });

    it('lets a custom retryOnStatusCodes list exclude a normally-retryable status', () => {
      const error = new RetryError({ message: 'x', reason: 'SERVER_ERROR', status: 500 });
      expect(isRetryable(error, { retryOnStatusCodes: [502, 503] })).toBe(false);
    });

    it('lets a custom retryOn predicate override classification entirely', () => {
      const error = new RetryError({ message: 'x', reason: 'CLIENT_ERROR', status: 400 });
      expect(isRetryable(error, { retryOn: () => true })).toBe(true);
      const network = new RetryError({ message: 'x', reason: 'NETWORK_ERROR' });
      expect(isRetryable(network, { retryOn: () => false })).toBe(false);
    });
  });

  describe('parseRetryAfter', () => {
    it('parses numeric seconds', () => {
      expect(parseRetryAfter('10')).toBe(10000);
    });

    it('parses an HTTP-date in the future', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const ms = parseRetryAfter(future);
      expect(ms).not.toBeNull();
      expect(ms as number).toBeGreaterThan(0);
      expect(ms as number).toBeLessThanOrEqual(5100);
    });

    it('returns 0 for a past HTTP-date rather than a negative delay', () => {
      const past = new Date(Date.now() - 5000).toUTCString();
      expect(parseRetryAfter(past)).toBe(0);
    });

    it('returns null for missing or unparsable values', () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter(undefined)).toBeNull();
      expect(parseRetryAfter('not-a-date-or-number')).toBeNull();
    });
  });
});
