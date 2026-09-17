import { FetchAdapter } from '../adapters/FetchAdapter';
import { type AppStateLike } from '../lifecycle/AppLifecycleManager';
import { type NetworkMonitor } from '../network/NetworkManager';
import { type AsyncStorageLike } from '../storage/AsyncStorageStorage';
import type { QueueStorage } from '../storage/QueueStorage';
import type { QueuedRequest, SmartRetryConfig, SmartRetryRequestOptions, SmartRetryResult } from '../types';
export interface SmartRetryClientOptions {
    /** Override the AsyncStorage-compatible storage backend. Defaults to `@react-native-async-storage/async-storage`. */
    storage?: QueueStorage;
    asyncStorage?: AsyncStorageLike;
    /** Override the network monitor. Defaults to `@react-native-community/netinfo` when installed. */
    networkMonitor?: NetworkMonitor;
    /** Override the AppState-compatible source used for background/foreground detection. */
    appState?: AppStateLike | null;
    /** Override the HTTP execution adapter. Defaults to a `fetch`-based adapter. */
    fetchAdapter?: FetchAdapter;
}
/**
 * Orchestrates the public SmartRetry API: immediate requests, the persistent
 * offline queue, automatic network-triggered sync, and app lifecycle
 * awareness. Construct via `createSmartRetry()` for an isolated instance
 * (useful in tests); most consumers should use the default `SmartRetry`
 * singleton exported from the package root.
 */
export declare class SmartRetryClient {
    private config;
    private readonly logger;
    private readonly events;
    private readonly fetchAdapter;
    private readonly retryEngine;
    private readonly requestManager;
    private readonly networkManager;
    private readonly queueManager;
    private readonly lifecycleManager;
    private initPromise;
    constructor(options?: SmartRetryClientOptions);
    configure(config: SmartRetryConfig): void;
    initialize(): Promise<void>;
    destroy(): void;
    request<T = unknown>(options: SmartRetryRequestOptions): Promise<SmartRetryResult<T>>;
    queue(options: SmartRetryRequestOptions): Promise<SmartRetryResult>;
    processQueue(): Promise<void>;
    getQueue(): Promise<QueuedRequest[]>;
    getQueueCount(): Promise<number>;
    remove(id: string): Promise<void>;
    clearQueue(): Promise<void>;
    isOnline(): Promise<boolean>;
    private doInitialize;
    private createDefaultStorage;
    private buildGlobalPolicy;
    private buildRequestPolicy;
    private wireEvents;
}
/** Creates an isolated SmartRetry instance. Prefer this over the singleton in tests. */
export declare function createSmartRetry(options?: SmartRetryClientOptions): SmartRetryClient;
//# sourceMappingURL=SmartRetry.d.ts.map