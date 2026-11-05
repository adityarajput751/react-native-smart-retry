import type { RetryReason, SerializedError } from '../types';
import { RetryError } from './RetryError';

/** HTTP status codes retried by default. */
export const DEFAULT_RETRYABLE_STATUS_CODES: readonly number[] = [408, 429, 500, 502, 503, 504];

/** HTTP status codes never retried automatically by default. */
export const DEFAULT_NON_RETRYABLE_STATUS_CODES: readonly number[] = [400, 401, 403, 404, 422];

/**
 * Classifies a thrown error (one that occurred before an HTTP response was
 * received) into a RetryError. Covers fetch's platform-specific network
 * failure messages and abort/timeout signals.
 */
export function classifyThrownError(error: unknown, options?: { wasTimeout?: boolean }): RetryError {
  if (error instanceof RetryError) {
    return error;
  }

  if (options?.wasTimeout) {
    return new RetryError({
      message: 'Request timed out',
      reason: 'TIMEOUT',
      isTimeout: true,
      cause: error,
    });
  }

  if (isAbortError(error)) {
    return new RetryError({ message: 'Request aborted', reason: 'ABORTED', cause: error });
  }

  // React Native's fetch rejects with this when the native request times out.
  if (error instanceof TypeError && getMessage(error).toLowerCase().includes('timed out')) {
    return new RetryError({ message: getMessage(error), reason: 'TIMEOUT', isTimeout: true, cause: error });
  }

  if (isNetworkError(error)) {
    return new RetryError({
      message: getMessage(error) || 'Network request failed',
      reason: 'NETWORK_ERROR',
      isNetworkError: true,
      cause: error,
    });
  }

  return new RetryError({
    message: getMessage(error) || 'Unknown error',
    reason: 'UNKNOWN',
    cause: error,
  });
}

/**
 * Classifies an HTTP error response (a response that was received, but whose
 * status code indicates failure) into a RetryError.
 */
export function classifyStatusError(
  status: number,
  options?: { retryOnStatusCodes?: number[]; retryAfterMs?: number; statusText?: string; data?: unknown }
): RetryError {
  const reason = statusToReason(status, options?.retryOnStatusCodes);
  return new RetryError({
    message: options?.statusText ? `HTTP ${status}: ${options.statusText}` : `HTTP ${status}`,
    reason,
    status,
    retryAfterMs: options?.retryAfterMs,
    data: options?.data,
  });
}

function statusToReason(status: number, retryOnStatusCodes?: number[]): RetryReason {
  if (status === 429) {
    return 'RATE_LIMIT';
  }

  const retryable = retryOnStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  if (retryable.includes(status)) {
    return 'SERVER_ERROR';
  }

  if (status >= 400 && status < 500) {
    return 'CLIENT_ERROR';
  }

  if (status >= 500) {
    return 'SERVER_ERROR';
  }

  return 'UNKNOWN';
}

/**
 * Determines whether a classified error should be retried, honoring a custom
 * `retryOn` predicate (takes precedence when provided) and a custom set of
 * retryable status codes.
 */
export function isRetryable(
  error: RetryError,
  options?: { retryOnStatusCodes?: number[]; retryOn?: (error: unknown) => boolean }
): boolean {
  if (error.reason === 'ABORTED' || error.reason === 'EXPIRED' || error.reason === 'QUEUE_FULL') {
    return false;
  }

  if (options?.retryOn) {
    return options.retryOn(error);
  }

  if (error.reason === 'NETWORK_ERROR' || error.reason === 'TIMEOUT' || error.reason === 'RATE_LIMIT') {
    return true;
  }

  if (error.reason === 'SERVER_ERROR') {
    if (typeof error.status === 'number') {
      const retryable = options?.retryOnStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
      return retryable.includes(error.status);
    }
    return true;
  }

  return false;
}

/**
 * Whether a failed `queue: true` request belongs in the persistent queue:
 * connectivity failures and retryable server responses do; permanent failures
 * do not, because replaying them could only fail again. `retryOn` is not
 * consulted, since it cannot survive persistence and so cannot govern replays.
 */
export function shouldQueue(error: RetryError, options?: { retryOnStatusCodes?: number[] }): boolean {
  return isRetryable(error, { retryOnStatusCodes: options?.retryOnStatusCodes });
}

/** Parses a `Retry-After` header value: numeric seconds or an HTTP-date. Returns ms, or null. */
export function parseRetryAfter(headerValue: string | null | undefined): number | null {
  if (!headerValue) {
    return null;
  }

  const trimmed = headerValue.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

/**
 * Converts a RetryError to plain data. `includeData` adds the response body;
 * leave it off for anything written to storage, since bodies can be large or
 * sensitive.
 */
export function serializeError(error: RetryError, options?: { includeData?: boolean }): SerializedError {
  return {
    message: error.message,
    name: error.name,
    status: error.status,
    reason: error.reason,
    isNetworkError: error.isNetworkError,
    isTimeout: error.isTimeout,
    ...(options?.includeData && error.data !== undefined ? { data: error.data } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const named = error as { name?: unknown };
  return named.name === 'AbortError';
}

function isNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const message = getMessage(error).toLowerCase();
  const isTypeError = error instanceof TypeError;

  const networkMessages = [
    'network request failed',
    'failed to fetch',
    'load failed',
    'network error',
    'the internet connection appears to be offline',
  ];

  if (isTypeError && (message === '' || networkMessages.some((m) => message.includes(m)))) {
    return true;
  }

  return networkMessages.some((m) => message.includes(m));
}

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '';
}
