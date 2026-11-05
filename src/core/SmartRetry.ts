import { FetchAdapter, type FetchAdapterRequest, type RequestSender } from '../adapters/FetchAdapter';
import {
  classifyThrownError,
  DEFAULT_RETRYABLE_STATUS_CODES,
  serializeError,
  shouldQueue,
} from '../errors/ErrorClassifier';
import { RetryError } from '../errors/RetryError';
import {
  AppLifecycleManager,
  createDefaultAppState,
  type AppStateLike,
} from '../lifecycle/AppLifecycleManager';
import { createDefaultNetworkMonitor, NetworkManager, type NetworkMonitor } from '../network/NetworkManager';
import { calculateDelay } from '../retry/calculateDelay';
import { RetryEngine } from '../retry/RetryEngine';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../retry/RetryPolicy';
import { AsyncStorageStorage, type AsyncStorageLike } from '../storage/AsyncStorageStorage';
import type { QueueStorage } from '../storage/QueueStorage';
import type {
  HttpMethod,
  QueuedRequest,
  QueueStatus,
  SmartRetryConfig,
  SmartRetryRequestOptions,
  SmartRetryResult,
} from '../types';
import { logger } from '../utils/logger';
import { QueueEventEmitter, type QueueEventMap } from '../queue/QueueEvents';
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
  >
> {
  retryMethods?: HttpMethod[];
  baseURL?: string;
  beforeRequest?: SmartRetryConfig['beforeRequest'];
  onUnauthorized?: SmartRetryConfig['onUnauthorized'];
  maxQueueSize?: number;
  maxRequestAge?: number;
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
};

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Defers resolving the default backend to first use, so that importing this
 * package (which constructs the singleton) cannot fail for apps that only use
 * `createSmartRetry({ storage })` and never install AsyncStorage.
 */
function createLazyStorage(load: () => QueueStorage): QueueStorage {
  let storage: QueueStorage | undefined;
  const resolve = async (): Promise<QueueStorage> => (storage ??= load());
  return {
    add: async (request) => (await resolve()).add(request),
    getAll: async () => (await resolve()).getAll(),
    get: async (id) => (await resolve()).get(id),
    update: async (id, data) => (await resolve()).update(id, data),
    remove: async (id) => (await resolve()).remove(id),
    clear: async () => (await resolve()).clear(),
  };
}

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
  private readonly logger = logger;
  private readonly events = new QueueEventEmitter();
  private readonly fetchAdapter: FetchAdapter;
  private readonly retryEngine = new RetryEngine();
  private readonly requestManager: RequestManager;
  private readonly networkManager: NetworkManager;
  private readonly queueManager: QueueManager;
  private readonly lifecycleManager: AppLifecycleManager | null;

  private initPromise: Promise<void> | null = null;
  private authRefresh: Promise<boolean> | null = null;
  private readonly inFlightByUniqueKey = new Map<string, Promise<SmartRetryResult<unknown>>>();

  constructor(options: SmartRetryClientOptions = {}) {
    this.fetchAdapter = options.fetchAdapter ?? new FetchAdapter();
    this.requestManager = new RequestManager({
      send: this.send,
      retryEngine: this.retryEngine,
      getDefaultTimeout: () => this.config.timeout,
      onRetry: (info) => this.events.emit('retry', info),
    });

    const monitor = options.networkMonitor ?? createDefaultNetworkMonitor();
    this.networkManager = new NetworkManager(monitor);

    const storage = options.storage ?? this.createDefaultStorage(options.asyncStorage);

    this.queueManager = new QueueManager({
      storage,
      networkManager: this.networkManager,
      send: this.send,
      events: this.events,
      logger: this.logger,
      getPolicy: () => this.buildGlobalPolicy(),
      getDefaultTimeout: () => this.config.timeout,
      preventDuplicates: () => this.config.preventDuplicates,
      getTransformBeforePersist: () => this.config.transformBeforePersist,
      getMaxQueueSize: () => this.config.maxQueueSize,
      getMaxRequestAge: () => this.config.maxRequestAge,
    });

    const appState = options.appState !== undefined ? options.appState : createDefaultAppState();
    this.lifecycleManager = appState ? new AppLifecycleManager(appState) : null;

    this.wireEvents();
  }

  configure(config: SmartRetryConfig): void {
    // An explicit `undefined` means "not set", not "clear the default".
    const defined = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    this.config = { ...this.config, ...defined };
    if (config.debug !== undefined) {
      this.logger.setEnabled(config.debug);
    }
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  destroy(): void {
    this.queueManager.destroy();
    this.networkManager.destroy();
    this.lifecycleManager?.destroy();
    this.initPromise = null;
  }

  /**
   * Sends a request. Resolves with a `success`, `queued` or `failed` result and
   * does not reject for request or queue failures.
   */
  request<T = unknown>(rawOptions: SmartRetryRequestOptions): Promise<SmartRetryResult<T>> {
    const options = this.normalizeOptions(rawOptions);
    const key = options.queue && this.config.preventDuplicates ? options.uniqueKey : undefined;
    if (!key) {
      return this.executeRequest<T>(options);
    }

    // A double-tap must not send twice just because the first tap has not reached the queue yet.
    const inFlight = this.inFlightByUniqueKey.get(key);
    if (inFlight) {
      return inFlight as Promise<SmartRetryResult<T>>;
    }

    const result = this.executeRequest<T>(options).finally(() => {
      this.inFlightByUniqueKey.delete(key);
    });
    this.inFlightByUniqueKey.set(key, result);
    return result;
  }

  /** Stores a request for background delivery, without a live attempt. */
  async queue(rawOptions: SmartRetryRequestOptions): Promise<SmartRetryResult> {
    await this.initialize();
    return this.enqueue(this.normalizeOptions(rawOptions));
  }

  /** Runs a processing pass now, ignoring any backoff delay. */
  async processQueue(): Promise<void> {
    await this.initialize();
    return this.queueManager.processNow({ force: true });
  }

  /** Subscribes to a queue event. Returns an unsubscribe function. */
  on<K extends keyof QueueEventMap>(event: K, listener: (payload: QueueEventMap[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  /** Whether a queue processing pass is currently running. */
  isProcessing(): boolean {
    return this.queueManager.isProcessing();
  }

  async getQueue(): Promise<QueuedRequest[]> {
    await this.initialize();
    return this.queueManager.getAll();
  }

  /** Counts stored requests, optionally only those with a given status. */
  async getQueueCount(status?: QueueStatus): Promise<number> {
    await this.initialize();
    return this.queueManager.getCount(status);
  }

  async remove(id: string): Promise<void> {
    await this.initialize();
    return this.queueManager.remove(id);
  }

  async clearQueue(): Promise<void> {
    await this.initialize();
    return this.queueManager.clear();
  }

  /**
   * Returns `failed` requests to the back of the queue with a fresh retry
   * budget: just request `id`, or all of them. Resolves to how many were reset.
   */
  async retryFailed(id?: string): Promise<number> {
    await this.initialize();
    return this.queueManager.retryFailed(id);
  }

  async isOnline(): Promise<boolean> {
    return this.networkManager.isOnline();
  }

  private async doInitialize(): Promise<void> {
    this.logger.log('Initialized');
    this.lifecycleManager?.start();
    if (this.config.pauseWhenBackgrounded && this.lifecycleManager?.getCurrentState() === 'background') {
      this.queueManager.pause();
    }
    await this.queueManager.initialize();
  }

  private async executeRequest<T>(options: SmartRetryRequestOptions): Promise<SmartRetryResult<T>> {
    await this.initialize();

    if (options.queue && options.uniqueKey && this.config.preventDuplicates) {
      const existing = await this.queueManager.findActiveByUniqueKey(options.uniqueKey).catch(() => null);
      if (existing) {
        return { status: 'queued', queued: true, queueId: existing.id };
      }
    }

    const policy = this.buildRequestPolicy(options);
    const result = await this.requestManager.execute<T>(options, policy);

    if (result.ok) {
      this.logger.log('Request successful');
      const { data, status, headers } = result.response;
      return { status: 'success', queued: false, response: data, httpStatus: status, headers };
    }

    const { error } = result;

    if (options.queue && shouldQueue(error, { retryOnStatusCodes: policy.retryOnStatusCodes })) {
      this.logger.log('Request failed; queueing');
      return this.enqueue(options, {
        lastError: serializeError(error),
        nextAttemptAt: this.firstAttemptTime(error, policy),
      });
    }

    this.logger.log('Request failed');
    return { status: 'failed', queued: false, error: serializeError(error, { includeData: true }) };
  }

  /**
   * When to first replay a request whose live attempt just failed. A connectivity
   * failure can go as soon as the network allows; a server that answered has
   * asked for, or deserves, some time first.
   */
  private firstAttemptTime(error: RetryError, policy: RetryPolicy): number | undefined {
    if (error.isNetworkError || error.isTimeout) {
      return undefined;
    }
    return Date.now() + calculateDelay({ ...policy, attempt: 1, retryAfterMs: error.retryAfterMs });
  }

  private async enqueue(
    options: SmartRetryRequestOptions,
    initial?: Pick<QueuedRequest, 'lastError' | 'nextAttemptAt'>
  ): Promise<SmartRetryResult<never>> {
    try {
      const item = await this.queueManager.enqueue(options, initial);
      return { status: 'queued', queued: true, queueId: item.id };
    } catch (rawError) {
      const error = classifyThrownError(rawError);
      this.logger.warn('Could not store request', error.message);
      return { status: 'failed', queued: false, error: serializeError(error) };
    }
  }

  private normalizeOptions(options: SmartRetryRequestOptions): SmartRetryRequestOptions {
    const { baseURL } = this.config;
    if (!baseURL || ABSOLUTE_URL.test(options.url)) {
      return options;
    }
    return { ...options, url: `${baseURL.replace(/\/+$/, '')}/${options.url.replace(/^\/+/, '')}` };
  }

  /** One HTTP attempt with the app's auth hooks applied. Used by live requests and queue replays. */
  private readonly send: RequestSender = async <T>(request: FetchAdapterRequest) => {
    const attempt = async () => this.fetchAdapter.execute<T>(await this.prepare(request));

    try {
      return await attempt();
    } catch (error) {
      if (error instanceof RetryError && error.status === 401 && (await this.refreshAuth(error))) {
        return attempt();
      }
      throw error;
    }
  };

  private async prepare(request: FetchAdapterRequest): Promise<FetchAdapterRequest> {
    const { beforeRequest } = this.config;
    if (!beforeRequest) {
      return request;
    }
    const { url, method, headers, data } = request;
    return { ...request, ...(await beforeRequest({ url, method, headers, data })) };
  }

  /** Runs `onUnauthorized`, sharing one call between concurrent `401`s. */
  private refreshAuth(error: RetryError): Promise<boolean> {
    const { onUnauthorized } = this.config;
    if (!onUnauthorized) {
      return Promise.resolve(false);
    }

    if (!this.authRefresh) {
      this.authRefresh = Promise.resolve()
        .then(() => onUnauthorized(serializeError(error, { includeData: true })))
        .then(Boolean, (hookError: unknown) => {
          this.logger.warn('onUnauthorized threw', hookError);
          return false;
        })
        .finally(() => {
          this.authRefresh = null;
        });
    }
    return this.authRefresh;
  }

  private createDefaultStorage(asyncStorageOverride?: AsyncStorageLike): QueueStorage {
    if (asyncStorageOverride) {
      return new AsyncStorageStorage(asyncStorageOverride);
    }

    return createLazyStorage(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        return new AsyncStorageStorage(AsyncStorage);
      } catch {
        throw new Error(
          '[SmartRetry] "@react-native-async-storage/async-storage" is required but was not found. ' +
            'Install it with `npm install @react-native-async-storage/async-storage`, or pass a custom ' +
            '`storage` implementation to createSmartRetry().'
        );
      }
    });
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
      if (state === 'background' && this.config.pauseWhenBackgrounded) {
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
