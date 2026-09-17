import { FetchAdapter } from '../adapters/FetchAdapter';
import { DEFAULT_RETRYABLE_STATUS_CODES, serializeError } from '../errors/ErrorClassifier';
import {
  AppLifecycleManager,
  createDefaultAppState,
  type AppStateLike,
} from '../lifecycle/AppLifecycleManager';
import { createDefaultNetworkMonitor, NetworkManager, type NetworkMonitor } from '../network/NetworkManager';
import { RetryEngine } from '../retry/RetryEngine';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../retry/RetryPolicy';
import { AsyncStorageStorage, type AsyncStorageLike } from '../storage/AsyncStorageStorage';
import type { QueueStorage } from '../storage/QueueStorage';
import type {
  HttpMethod,
  QueuedRequest,
  SmartRetryConfig,
  SmartRetryRequestOptions,
  SmartRetryResult,
} from '../types';
import { Logger } from '../utils/logger';
import { QueueEventEmitter } from '../queue/QueueEvents';
import { QueueManager } from '../queue/QueueManager';
import { RequestManager } from './RequestManager';

/** Fully-resolved configuration (every optional field defaulted). */
interface ResolvedConfig extends Required<
  Pick<
    SmartRetryConfig,
    | 'debug'
    | 'pauseWhenBackgrounded'
    | 'preventDuplicates'
    | 'strategy'
    | 'baseDelay'
    | 'maxDelay'
    | 'retries'
    | 'timeout'
    | 'retryOnStatusCodes'
    | 'staleProcessingThresholdMs'
  >
> {
  retryMethods?: HttpMethod[];
  transformBeforePersist?: (request: QueuedRequest) => QueuedRequest;
  onQueued?: SmartRetryConfig['onQueued'];
  onRetry?: SmartRetryConfig['onRetry'];
  onSuccess?: SmartRetryConfig['onSuccess'];
  onFailure?: SmartRetryConfig['onFailure'];
  onQueueStart?: SmartRetryConfig['onQueueStart'];
  onQueueComplete?: SmartRetryConfig['onQueueComplete'];
  onNetworkChange?: SmartRetryConfig['onNetworkChange'];
}

const DEFAULT_CONFIG: ResolvedConfig = {
  debug: false,
  pauseWhenBackgrounded: true,
  preventDuplicates: true,
  strategy: DEFAULT_RETRY_POLICY.strategy,
  baseDelay: DEFAULT_RETRY_POLICY.baseDelay,
  maxDelay: DEFAULT_RETRY_POLICY.maxDelay,
  retries: DEFAULT_RETRY_POLICY.retries,
  timeout: 15000,
  retryOnStatusCodes: [...DEFAULT_RETRYABLE_STATUS_CODES],
  staleProcessingThresholdMs: 60000,
};

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
export class SmartRetryClient {
  private config: ResolvedConfig = { ...DEFAULT_CONFIG };
  private readonly logger = new Logger(false);
  private readonly events = new QueueEventEmitter();
  private readonly fetchAdapter: FetchAdapter;
  private readonly retryEngine = new RetryEngine();
  private readonly requestManager: RequestManager;
  private readonly networkManager: NetworkManager;
  private readonly queueManager: QueueManager;
  private readonly lifecycleManager: AppLifecycleManager | null;

  private initPromise: Promise<void> | null = null;

  constructor(options: SmartRetryClientOptions = {}) {
    this.fetchAdapter = options.fetchAdapter ?? new FetchAdapter();
    this.requestManager = new RequestManager({
      fetchAdapter: this.fetchAdapter,
      retryEngine: this.retryEngine,
      onRetry: (info) => this.events.emit('retry', info),
    });

    const monitor = options.networkMonitor ?? createDefaultNetworkMonitor();
    this.networkManager = new NetworkManager(monitor);

    const storage = options.storage ?? this.createDefaultStorage(options.asyncStorage);

    this.queueManager = new QueueManager({
      storage,
      networkManager: this.networkManager,
      fetchAdapter: this.fetchAdapter,
      events: this.events,
      logger: this.logger,
      getPolicy: () => this.buildGlobalPolicy(),
      getDefaultTimeout: () => this.config.timeout,
      preventDuplicates: () => this.config.preventDuplicates,
      getTransformBeforePersist: () => this.config.transformBeforePersist,
      staleProcessingThresholdMs: () => this.config.staleProcessingThresholdMs,
    });

    const appState = options.appState !== undefined ? options.appState : createDefaultAppState();
    this.lifecycleManager = appState ? new AppLifecycleManager(appState) : null;

    this.wireEvents();
  }

  configure(config: SmartRetryConfig): void {
    this.config = { ...this.config, ...config };
    this.logger.setEnabled(this.config.debug);
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  destroy(): void {
    this.queueManager.destroy();
    this.networkManager.destroy();
    this.lifecycleManager?.destroy();
    this.initPromise = null;
  }

  async request<T = unknown>(options: SmartRetryRequestOptions): Promise<SmartRetryResult<T>> {
    await this.initialize();

    const policy = this.buildRequestPolicy(options);
    const result = await this.requestManager.execute<T>(options, policy);

    if (result.ok) {
      this.logger.log('Request successful');
      return { status: 'success', queued: false, response: result.response.data };
    }

    const error = result.error;

    if (error.reason === 'CLIENT_ERROR') {
      this.logger.log('Request failed permanently (client error)');
      return { status: 'failed', queued: false, error: serializeError(error) };
    }

    if (options.queue) {
      this.logger.log('Request failed; queueing');
      const item = await this.queueManager.enqueue(options);
      return { status: 'queued', queued: true, queueId: item.id };
    }

    this.logger.log('Request failed');
    return { status: 'failed', queued: false, error: serializeError(error) };
  }

  async queue(options: SmartRetryRequestOptions): Promise<SmartRetryResult> {
    await this.initialize();
    const item = await this.queueManager.enqueue(options);
    return { status: 'queued', queued: true, queueId: item.id };
  }

  async processQueue(): Promise<void> {
    await this.initialize();
    return this.queueManager.processNow();
  }

  async getQueue(): Promise<QueuedRequest[]> {
    await this.initialize();
    return this.queueManager.getAll();
  }

  async getQueueCount(): Promise<number> {
    await this.initialize();
    return this.queueManager.getCount();
  }

  async remove(id: string): Promise<void> {
    await this.initialize();
    return this.queueManager.remove(id);
  }

  async clearQueue(): Promise<void> {
    await this.initialize();
    return this.queueManager.clear();
  }

  async isOnline(): Promise<boolean> {
    return this.networkManager.isOnline();
  }

  private async doInitialize(): Promise<void> {
    this.logger.log('Initialized');
    this.lifecycleManager?.start();
    await this.queueManager.initialize();
  }

  private createDefaultStorage(asyncStorageOverride?: AsyncStorageLike): QueueStorage {
    if (asyncStorageOverride) {
      return new AsyncStorageStorage(asyncStorageOverride);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      return new AsyncStorageStorage(AsyncStorage);
    } catch (error) {
      throw new Error(
        '[SmartRetry] "@react-native-async-storage/async-storage" is required but was not found. ' +
          'Install it with `npm install @react-native-async-storage/async-storage`, or pass a custom ' +
          '`storage` implementation to createSmartRetry().'
      );
    }
  }

  private buildGlobalPolicy(): RetryPolicy {
    return {
      strategy: this.config.strategy,
      baseDelay: this.config.baseDelay,
      maxDelay: this.config.maxDelay,
      retries: this.config.retries,
      retryOnStatusCodes: this.config.retryOnStatusCodes,
      retryMethods: this.config.retryMethods,
    };
  }

  private buildRequestPolicy(options: SmartRetryRequestOptions): RetryPolicy {
    return {
      strategy: options.strategy ?? this.config.strategy,
      baseDelay: options.baseDelay ?? this.config.baseDelay,
      maxDelay: options.maxDelay ?? this.config.maxDelay,
      retries: options.retries ?? this.config.retries,
      retryOnStatusCodes: options.retryOnStatusCodes ?? this.config.retryOnStatusCodes,
      retryOn: options.retryOn,
      retryMethods: options.retryMethods ?? this.config.retryMethods,
    };
  }

  private wireEvents(): void {
    this.events.on('queued', (request) => this.config.onQueued?.(request));
    this.events.on('retry', (info) => this.config.onRetry?.(info));
    this.events.on('success', ({ request, response }) => this.config.onSuccess?.(request, response));
    this.events.on('failure', ({ request, error }) => this.config.onFailure?.(request, error));
    this.events.on('queueStart', () => this.config.onQueueStart?.());
    this.events.on('queueComplete', (summary) => this.config.onQueueComplete?.(summary));
    this.events.on('networkChange', (state) => this.config.onNetworkChange?.(state));

    this.lifecycleManager?.subscribe((state) => {
      if (!this.config.pauseWhenBackgrounded) {
        return;
      }
      if (state === 'background') {
        this.queueManager.pause();
      } else if (state === 'active') {
        this.queueManager.resume();
        this.queueManager.processNow().catch((error: unknown) => {
          this.logger.warn('Resuming queue processing failed', error);
        });
      }
    });
  }
}

/** Creates an isolated SmartRetry instance. Prefer this over the singleton in tests. */
export function createSmartRetry(options?: SmartRetryClientOptions): SmartRetryClient {
  return new SmartRetryClient(options);
}
