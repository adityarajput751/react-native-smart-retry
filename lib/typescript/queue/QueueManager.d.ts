import { FetchAdapter } from '../adapters/FetchAdapter';
import type { NetworkManager } from '../network/NetworkManager';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { QueueStorage } from '../storage/QueueStorage';
import type { QueuedRequest, SmartRetryRequestOptions } from '../types';
import type { Logger } from '../utils/logger';
import { QueueEventEmitter } from './QueueEvents';
export interface QueueManagerOptions {
    storage: QueueStorage;
    networkManager: NetworkManager;
    fetchAdapter: FetchAdapter;
    events: QueueEventEmitter;
    logger: Logger;
    getPolicy: () => RetryPolicy;
    getDefaultTimeout: () => number;
    preventDuplicates: () => boolean;
    getTransformBeforePersist: () => ((request: QueuedRequest) => QueuedRequest) | undefined;
    staleProcessingThresholdMs: () => number;
}
/**
 * Owns the persistent queue's lifecycle: duplicate protection on insert,
 * network-triggered auto-processing, and delegation to {@link QueueProcessor}
 * for the actual FIFO replay.
 */
export declare class QueueManager {
    private readonly storage;
    private readonly networkManager;
    private readonly fetchAdapter;
    private readonly events;
    private readonly logger;
    private readonly getPolicy;
    private readonly getDefaultTimeout;
    private readonly preventDuplicates;
    private readonly getTransformBeforePersist;
    private readonly processor;
    private unsubscribeNetwork;
    private lastOnline;
    private initialized;
    constructor(options: QueueManagerOptions);
    initialize(): Promise<void>;
    destroy(): void;
    enqueue(options: SmartRetryRequestOptions): Promise<QueuedRequest>;
    getAll(): Promise<QueuedRequest[]>;
    getCount(): Promise<number>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    processNow(): Promise<void>;
    isProcessing(): boolean;
    pause(): void;
    resume(): void;
    isOnline(): Promise<boolean>;
    private findActiveByUniqueKey;
    private readonly executeRequest;
    private readonly handleNetworkChange;
}
//# sourceMappingURL=QueueManager.d.ts.map