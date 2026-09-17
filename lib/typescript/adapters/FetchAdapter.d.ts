import type { HttpMethod } from '../types';
export interface FetchAdapterRequest {
    url: string;
    method: HttpMethod;
    headers?: Record<string, string>;
    data?: unknown;
    /** Request timeout in milliseconds. Default: 15000. */
    timeout?: number;
    /** Sent as an `Idempotency-Key` header when provided and not already set in `headers`. */
    idempotencyKey?: string;
    /** External abort signal (e.g. caller cancellation) composed with the internal timeout controller. */
    signal?: AbortSignal;
    retryOnStatusCodes?: number[];
}
export interface FetchAdapterResponse<T = unknown> {
    status: number;
    headers: Record<string, string>;
    data: T;
}
/**
 * Executes HTTP requests using the platform's global `fetch`. Kept as a thin,
 * swappable adapter so the core request/queue/retry logic never depends on
 * fetch directly.
 */
export declare class FetchAdapter {
    execute<T = unknown>(request: FetchAdapterRequest): Promise<FetchAdapterResponse<T>>;
    private hasHeader;
    private parseBody;
}
//# sourceMappingURL=FetchAdapter.d.ts.map