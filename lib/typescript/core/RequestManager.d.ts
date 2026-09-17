import type { FetchAdapter, FetchAdapterResponse } from '../adapters/FetchAdapter';
import { RetryError } from '../errors/RetryError';
import type { RetryEngine } from '../retry/RetryEngine';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { RetryInfo, SmartRetryRequestOptions } from '../types';
export interface RequestManagerDependencies {
    fetchAdapter: FetchAdapter;
    retryEngine: RetryEngine;
    onRetry?: (info: RetryInfo) => void;
}
export type RequestExecutionResult<T> = {
    ok: true;
    response: FetchAdapterResponse<T>;
} | {
    ok: false;
    error: RetryError;
};
/**
 * Executes a single immediate (non-queued) request, applying in-process
 * retry-with-backoff for transient failures (network blips, timeouts,
 * retryable server errors) via the RetryEngine. Never touches the persistent
 * queue — that decision is made by the caller based on the final result.
 */
export declare class RequestManager {
    private readonly fetchAdapter;
    private readonly retryEngine;
    private readonly onRetry;
    constructor(deps: RequestManagerDependencies);
    execute<T = unknown>(options: SmartRetryRequestOptions, policy: RetryPolicy): Promise<RequestExecutionResult<T>>;
}
//# sourceMappingURL=RequestManager.d.ts.map