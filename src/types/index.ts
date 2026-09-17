/**
 * Public and internal type definitions for react-native-smart-retry.
 */

/** HTTP methods supported by SmartRetry. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Lifecycle status of a queued request. */
export type QueueStatus = 'pending' | 'processing' | 'failed';

/** Classification of why a request failed, used to decide retry behavior. */
export type RetryReason =
  'NETWORK_ERROR' | 'TIMEOUT' | 'SERVER_ERROR' | 'RATE_LIMIT' | 'CLIENT_ERROR' | 'UNKNOWN';

/** Backoff strategies supported by the retry engine. */
export type RetryStrategy = 'fixed' | 'linear' | 'exponential' | 'exponential-jitter';

/** A JSON-serializable representation of an error, safe to persist to storage. */
export interface SerializedError {
  message: string;
  name?: string;
  status?: number;
  reason: RetryReason;
  isNetworkError: boolean;
  isTimeout: boolean;
}

/**
 * A request persisted to the offline queue. Contains everything required to
 * replay the request later, independent of the process that created it.
 */
export interface QueuedRequest {
  id: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  data?: unknown;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  status: QueueStatus;
  uniqueKey?: string;
  idempotencyKey?: string;
  lastError?: SerializedError;
  /** Timeout (ms) to apply when this request is replayed. */
  timeout?: number;
  /** Max retry attempts allowed for this specific request. Falls back to the global default when unset. */
  maxRetries?: number;
  /**
   * Per-request override of retryable status codes. Falls back to the global
   * default when unset. Only plain data survives persistence — a custom
   * `retryOn` predicate function cannot be stored, so it only applies to the
   * immediate (pre-queue) attempt, never to replays after an app restart.
   */
  retryOnStatusCodes?: number[];
  /** Earliest time (ms epoch) this request is eligible to be attempted again, set after a retryable failure. */
  nextAttemptAt?: number;
}

/** Options accepted by `SmartRetry.request()` / `SmartRetry.queue()`. */
export interface SmartRetryRequestOptions {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  data?: unknown;

  /** Explicitly opt this request into the persistent offline queue on failure. */
  queue?: boolean;

  /** Prevents duplicate pending requests that share this key. */
  uniqueKey?: string;

  /** Sent to the server as an `Idempotency-Key` header when set. */
  idempotencyKey?: string;

  /** Max retry attempts (immediate, in-memory retries for non-queued requests,
   * or max attempts while replaying a queued request). Default: 3. */
  retries?: number;

  /** Request timeout in milliseconds. Default: 15000. */
  timeout?: number;

  /** Backoff strategy. Default: 'exponential-jitter'. */
  strategy?: RetryStrategy;

  /** Maximum delay between retries, in milliseconds. Default: 30000. */
  maxDelay?: number;

  /** Base delay used by the backoff calculation, in milliseconds. Default: 1000. */
  baseDelay?: number;

  /** HTTP status codes that should be treated as retryable. */
  retryOnStatusCodes?: number[];

  /** Custom predicate to decide whether an error is retryable. Overrides status-code logic when provided. */
  retryOn?: (error: unknown) => boolean;

  /** Explicitly allow automatic retry of unsafe methods (POST/PUT/PATCH/DELETE). */
  retryMethods?: HttpMethod[];

  /** AbortSignal to cancel an in-flight (non-queued) request. */
  signal?: AbortSignal;
}

export interface SmartRetrySuccessResult<T = unknown> {
  status: 'success';
  queued: false;
  response: T;
}

export interface SmartRetryQueuedResult {
  status: 'queued';
  queued: true;
  queueId: string;
}

export interface SmartRetryFailedResult {
  status: 'failed';
  queued: false;
  error: SerializedError;
}

export type SmartRetryResult<T = unknown> =
  SmartRetrySuccessResult<T> | SmartRetryQueuedResult | SmartRetryFailedResult;

/** Metadata passed to the `onRetry` event listener. */
export interface RetryInfo {
  requestId: string;
  attempt: number;
  maxRetries: number;
  reason: RetryReason;
  delay: number;
}

/** Network connectivity state. */
export interface NetworkState {
  isConnected: boolean;
  isInternetReachable: boolean | null;
}

/** Listener signature for network state changes. */
export type NetworkListener = (state: NetworkState) => void;

/** Event callbacks that can be registered via `SmartRetry.configure()`. */
export interface SmartRetryEvents {
  onQueued?: (request: QueuedRequest) => void;
  onRetry?: (info: RetryInfo) => void;
  onSuccess?: (request: QueuedRequest, response: unknown) => void;
  onFailure?: (request: QueuedRequest, error: SerializedError) => void;
  onQueueStart?: () => void;
  onQueueComplete?: (summary: { processed: number; succeeded: number; failed: number }) => void;
  onNetworkChange?: (state: NetworkState) => void;
}

/** Global configuration accepted by `SmartRetry.configure()`. */
export interface SmartRetryConfig extends SmartRetryEvents {
  debug?: boolean;
  /** Pause queue processing while the app is backgrounded, resume on foreground. Default: true. */
  pauseWhenBackgrounded?: boolean;
  /** Enable duplicate protection via `uniqueKey`. Default: true. */
  preventDuplicates?: boolean;
  /** Default retry strategy for queued request replays. Default: 'exponential-jitter'. */
  strategy?: RetryStrategy;
  /** Default base delay in ms. Default: 1000. */
  baseDelay?: number;
  /** Default max delay in ms. Default: 30000. */
  maxDelay?: number;
  /** Default max retries before a queued request is marked 'failed'. Default: 5. */
  retries?: number;
  /** Default request timeout in ms. Default: 15000. */
  timeout?: number;
  /** HTTP status codes considered retryable by default. */
  retryOnStatusCodes?: number[];
  /** HTTP methods that queued requests are allowed to auto-retry. Default: all methods once queued. */
  retryMethods?: HttpMethod[];
  /**
   * Threshold (ms) after which a request stuck in 'processing' (e.g. due to a
   * crash mid-request) is considered stale and reset to 'pending' on init.
   * Default: 60000.
   */
  staleProcessingThresholdMs?: number;
  /**
   * Optional hook to transform/redact a request's data before it is persisted
   * to storage. Useful for stripping sensitive fields.
   */
  transformBeforePersist?: (request: QueuedRequest) => QueuedRequest;
}
