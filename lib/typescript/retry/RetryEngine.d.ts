import type { HttpMethod, RetryInfo } from '../types';
import { type RetryPolicy } from './RetryPolicy';
export interface ExecuteWithRetryOptions {
    requestId: string;
    method: HttpMethod;
    policy: RetryPolicy;
    signal?: AbortSignal;
    onRetry?: (info: RetryInfo) => void;
    /**
     * Whether NETWORK_ERROR/TIMEOUT failures may be retried in-process with a
     * backoff sleep. Defaults to true. `RequestManager` passes `false`: a
     * genuinely offline device should fail (or be queued, if `queue: true`)
     * immediately rather than blocking the caller for several seconds of
     * backoff sleeps that are very unlikely to succeed.
     */
    retryConnectivityErrors?: boolean;
}
/**
 * Generic, in-process retry-with-backoff engine used for immediate (not
 * queued) requests. Retries happen synchronously within a single call to
 * `SmartRetry.request()` — this is distinct from the persistent offline
 * queue, which instead defers a request across app sessions until
 * connectivity returns (see `QueueProcessor`).
 */
export declare class RetryEngine {
    executeWithRetry<T>(fn: () => Promise<T>, options: ExecuteWithRetryOptions): Promise<T>;
    private rethrowUnknown;
}
//# sourceMappingURL=RetryEngine.d.ts.map