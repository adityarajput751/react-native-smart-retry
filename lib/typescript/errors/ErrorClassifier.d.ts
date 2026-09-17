import type { SerializedError } from '../types';
import { RetryError } from './RetryError';
/** HTTP status codes retried by default. */
export declare const DEFAULT_RETRYABLE_STATUS_CODES: readonly number[];
/** HTTP status codes never retried automatically by default. */
export declare const DEFAULT_NON_RETRYABLE_STATUS_CODES: readonly number[];
/**
 * Classifies a thrown error (one that occurred before an HTTP response was
 * received) into a RetryError. Covers fetch's platform-specific network
 * failure messages and abort/timeout signals.
 */
export declare function classifyThrownError(error: unknown, options?: {
    wasTimeout?: boolean;
}): RetryError;
/**
 * Classifies an HTTP error response (a response that was received, but whose
 * status code indicates failure) into a RetryError.
 */
export declare function classifyStatusError(status: number, options?: {
    retryOnStatusCodes?: number[];
    retryAfterMs?: number;
    statusText?: string;
}): RetryError;
/**
 * Determines whether a classified error should be retried, honoring a custom
 * `retryOn` predicate (takes precedence when provided) and a custom set of
 * retryable status codes.
 */
export declare function isRetryable(error: RetryError, options?: {
    retryOnStatusCodes?: number[];
    retryOn?: (error: unknown) => boolean;
}): boolean;
/** Parses a `Retry-After` header value: numeric seconds or an HTTP-date. Returns ms, or null. */
export declare function parseRetryAfter(headerValue: string | null | undefined): number | null;
export declare function serializeError(error: RetryError): SerializedError;
//# sourceMappingURL=ErrorClassifier.d.ts.map