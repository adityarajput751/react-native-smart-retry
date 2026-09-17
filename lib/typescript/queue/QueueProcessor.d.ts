import type { NetworkManager } from '../network/NetworkManager';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { QueuedRequest } from '../types';
import { Logger } from '../utils/logger';
import type { QueueEventEmitter } from './QueueEvents';
import type { QueueStorage } from '../storage/QueueStorage';
export interface QueueRequestExecutionResult {
    status: number;
    data: unknown;
}
export type QueueRequestExecutor = (request: QueuedRequest) => Promise<QueueRequestExecutionResult>;
export interface QueueProcessorOptions {
    storage: QueueStorage;
    networkManager: NetworkManager;
    executeRequest: QueueRequestExecutor;
    events: QueueEventEmitter;
    getPolicy: () => RetryPolicy;
    staleProcessingThresholdMs: number;
    logger: Logger;
}
/**
 * Processes the persistent queue strictly in FIFO order, one request at a
 * time. Guarantees only a single processing run is ever active (concurrent
 * `process()` calls attach to the in-flight run) and never deletes a request
 * from storage until its replay has actually succeeded.
 */
export declare class QueueProcessor {
    private readonly storage;
    private readonly networkManager;
    private readonly executeRequest;
    private readonly events;
    private readonly getPolicy;
    private readonly staleProcessingThresholdMs;
    private readonly logger;
    private inFlight;
    private retryTimer;
    private destroyed;
    private paused;
    constructor(options: QueueProcessorOptions);
    /**
     * Runs (or attaches to) a single processing pass over the queue. Concurrent
     * calls never spawn a second processor — they resolve once the in-flight
     * run completes.
     */
    process(): Promise<void>;
    isProcessing(): boolean;
    pause(): void;
    resume(): void;
    destroy(): void;
    private run;
    private handleFailure;
    private recoverStaleProcessing;
    private scheduleRetryTimer;
    private clearRetryTimer;
}
//# sourceMappingURL=QueueProcessor.d.ts.map