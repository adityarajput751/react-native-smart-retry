import { FetchAdapter } from '../adapters/FetchAdapter';
import { DEFAULT_RETRYABLE_STATUS_CODES, serializeError } from '../errors/ErrorClassifier';
import { AppLifecycleManager, createDefaultAppState } from '../lifecycle/AppLifecycleManager';
import { createDefaultNetworkMonitor, NetworkManager } from '../network/NetworkManager';
import { RetryEngine } from '../retry/RetryEngine';
import { DEFAULT_RETRY_POLICY } from '../retry/RetryPolicy';
import { AsyncStorageStorage } from '../storage/AsyncStorageStorage';
import { Logger } from '../utils/logger';
import { QueueEventEmitter } from '../queue/QueueEvents';
import { QueueManager } from '../queue/QueueManager';
import { RequestManager } from './RequestManager';

/** Fully-resolved configuration (every optional field defaulted). */

const DEFAULT_CONFIG = {
  debug: false,
  pauseWhenBackgrounded: true,
  preventDuplicates: true,
  strategy: DEFAULT_RETRY_POLICY.strategy,
  baseDelay: DEFAULT_RETRY_POLICY.baseDelay,
  maxDelay: DEFAULT_RETRY_POLICY.maxDelay,
  retries: DEFAULT_RETRY_POLICY.retries,
  timeout: 15000,
  retryOnStatusCodes: [...DEFAULT_RETRYABLE_STATUS_CODES],
  staleProcessingThresholdMs: 60000
};
/**
 * Orchestrates the public SmartRetry API: immediate requests, the persistent
 * offline queue, automatic network-triggered sync, and app lifecycle
 * awareness. Construct via `createSmartRetry()` for an isolated instance
 * (useful in tests); most consumers should use the default `SmartRetry`
 * singleton exported from the package root.
 */
export class SmartRetryClient {
  config = {
    ...DEFAULT_CONFIG
  };
  logger = new Logger(false);
  events = new QueueEventEmitter();
  retryEngine = new RetryEngine();
  initPromise = null;
  constructor(options = {}) {
    this.fetchAdapter = options.fetchAdapter ?? new FetchAdapter();
    this.requestManager = new RequestManager({
      fetchAdapter: this.fetchAdapter,
      retryEngine: this.retryEngine,
      onRetry: info => this.events.emit('retry', info)
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
      staleProcessingThresholdMs: () => this.config.staleProcessingThresholdMs
    });
    const appState = options.appState !== undefined ? options.appState : createDefaultAppState();
    this.lifecycleManager = appState ? new AppLifecycleManager(appState) : null;
    this.wireEvents();
  }
  configure(config) {
    this.config = {
      ...this.config,
      ...config
    };
    this.logger.setEnabled(this.config.debug);
  }
  async initialize() {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }
  destroy() {
    this.queueManager.destroy();
    this.networkManager.destroy();
    this.lifecycleManager?.destroy();
    this.initPromise = null;
  }
  async request(options) {
    await this.initialize();
    const policy = this.buildRequestPolicy(options);
    const result = await this.requestManager.execute(options, policy);
    if (result.ok) {
      this.logger.log('Request successful');
      return {
        status: 'success',
        queued: false,
        response: result.response.data
      };
    }
    const error = result.error;
    if (error.reason === 'CLIENT_ERROR') {
      this.logger.log('Request failed permanently (client error)');
      return {
        status: 'failed',
        queued: false,
        error: serializeError(error)
      };
    }
    if (options.queue) {
      this.logger.log('Request failed; queueing');
      const item = await this.queueManager.enqueue(options);
      return {
        status: 'queued',
        queued: true,
        queueId: item.id
      };
    }
    this.logger.log('Request failed');
    return {
      status: 'failed',
      queued: false,
      error: serializeError(error)
    };
  }
  async queue(options) {
    await this.initialize();
    const item = await this.queueManager.enqueue(options);
    return {
      status: 'queued',
      queued: true,
      queueId: item.id
    };
  }
  async processQueue() {
    await this.initialize();
    return this.queueManager.processNow();
  }
  async getQueue() {
    await this.initialize();
    return this.queueManager.getAll();
  }
  async getQueueCount() {
    await this.initialize();
    return this.queueManager.getCount();
  }
  async remove(id) {
    await this.initialize();
    return this.queueManager.remove(id);
  }
  async clearQueue() {
    await this.initialize();
    return this.queueManager.clear();
  }
  async isOnline() {
    return this.networkManager.isOnline();
  }
  async doInitialize() {
    this.logger.log('Initialized');
    this.lifecycleManager?.start();
    await this.queueManager.initialize();
  }
  createDefaultStorage(asyncStorageOverride) {
    if (asyncStorageOverride) {
      return new AsyncStorageStorage(asyncStorageOverride);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      return new AsyncStorageStorage(AsyncStorage);
    } catch (error) {
      throw new Error('[SmartRetry] "@react-native-async-storage/async-storage" is required but was not found. ' + 'Install it with `npm install @react-native-async-storage/async-storage`, or pass a custom ' + '`storage` implementation to createSmartRetry().');
    }
  }
  buildGlobalPolicy() {
    return {
      strategy: this.config.strategy,
      baseDelay: this.config.baseDelay,
      maxDelay: this.config.maxDelay,
      retries: this.config.retries,
      retryOnStatusCodes: this.config.retryOnStatusCodes,
      retryMethods: this.config.retryMethods
    };
  }
  buildRequestPolicy(options) {
    return {
      strategy: options.strategy ?? this.config.strategy,
      baseDelay: options.baseDelay ?? this.config.baseDelay,
      maxDelay: options.maxDelay ?? this.config.maxDelay,
      retries: options.retries ?? this.config.retries,
      retryOnStatusCodes: options.retryOnStatusCodes ?? this.config.retryOnStatusCodes,
      retryOn: options.retryOn,
      retryMethods: options.retryMethods ?? this.config.retryMethods
    };
  }
  wireEvents() {
    this.events.on('queued', request => this.config.onQueued?.(request));
    this.events.on('retry', info => this.config.onRetry?.(info));
    this.events.on('success', ({
      request,
      response
    }) => this.config.onSuccess?.(request, response));
    this.events.on('failure', ({
      request,
      error
    }) => this.config.onFailure?.(request, error));
    this.events.on('queueStart', () => this.config.onQueueStart?.());
    this.events.on('queueComplete', summary => this.config.onQueueComplete?.(summary));
    this.events.on('networkChange', state => this.config.onNetworkChange?.(state));
    this.lifecycleManager?.subscribe(state => {
      if (!this.config.pauseWhenBackgrounded) {
        return;
      }
      if (state === 'background') {
        this.queueManager.pause();
      } else if (state === 'active') {
        this.queueManager.resume();
        this.queueManager.processNow().catch(error => {
          this.logger.warn('Resuming queue processing failed', error);
        });
      }
    });
  }
}

/** Creates an isolated SmartRetry instance. Prefer this over the singleton in tests. */
export function createSmartRetry(options) {
  return new SmartRetryClient(options);
}
//# sourceMappingURL=SmartRetry.js.map