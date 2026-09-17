import { FetchAdapter } from '../adapters/FetchAdapter';
import type { NetworkManager } from '../network/NetworkManager';
import { isOnlineState } from '../network/NetworkState';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { QueueStorage } from '../storage/QueueStorage';
import type { NetworkState, QueuedRequest, SmartRetryRequestOptions } from '../types';
import type { Logger } from '../utils/logger';
import { QueueEventEmitter } from './QueueEvents';
import { createQueueItem } from './QueueItem';
import { QueueProcessor, type QueueRequestExecutor } from './QueueProcessor';

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
export class QueueManager {
  private readonly storage: QueueStorage;
  private readonly networkManager: NetworkManager;
  private readonly fetchAdapter: FetchAdapter;
  private readonly events: QueueEventEmitter;
  private readonly logger: Logger;
  private readonly getPolicy: () => RetryPolicy;
  private readonly getDefaultTimeout: () => number;
  private readonly preventDuplicates: () => boolean;
  private readonly getTransformBeforePersist: () => ((request: QueuedRequest) => QueuedRequest) | undefined;
  private readonly processor: QueueProcessor;

  private unsubscribeNetwork: (() => void) | undefined;
  private lastOnline: boolean | null = null;
  private initialized = false;

  constructor(options: QueueManagerOptions) {
    this.storage = options.storage;
    this.networkManager = options.networkManager;
    this.fetchAdapter = options.fetchAdapter;
    this.events = options.events;
    this.logger = options.logger;
    this.getPolicy = options.getPolicy;
    this.getDefaultTimeout = options.getDefaultTimeout;
    this.preventDuplicates = options.preventDuplicates;
    this.getTransformBeforePersist = options.getTransformBeforePersist;

    this.processor = new QueueProcessor({
      storage: this.storage,
      networkManager: this.networkManager,
      executeRequest: this.executeRequest,
      events: this.events,
      getPolicy: this.getPolicy,
      staleProcessingThresholdMs: options.staleProcessingThresholdMs(),
      logger: this.logger,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    this.unsubscribeNetwork = this.networkManager.subscribe(this.handleNetworkChange);
    this.networkManager.start();

    const online = await this.networkManager.isOnline();
    this.lastOnline = online;
    this.logger.log(`Network: ${online ? 'online' : 'offline'}`);

    if (online) {
      await this.processor.process();
    }
  }

  destroy(): void {
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = undefined;
    this.processor.destroy();
    this.initialized = false;
    this.lastOnline = null;
  }

  async enqueue(options: SmartRetryRequestOptions): Promise<QueuedRequest> {
    if (this.preventDuplicates() && options.uniqueKey) {
      const existing = await this.findActiveByUniqueKey(options.uniqueKey);
      if (existing) {
        this.logger.log(`Duplicate suppressed for uniqueKey (existing ${existing.id})`);
        return existing;
      }
    }

    let item = createQueueItem(options);
    const transform = this.getTransformBeforePersist();
    if (transform) {
      item = transform(item);
    }

    await this.storage.add(item);
    this.logger.log(`Queueing request ${item.id}`);
    this.events.emit('queued', item);

    this.processor.process().catch((error: unknown) => {
      this.logger.warn('Queue processing after enqueue failed', error);
    });

    return item;
  }

  getAll(): Promise<QueuedRequest[]> {
    return this.storage.getAll();
  }

  async getCount(): Promise<number> {
    const all = await this.storage.getAll();
    return all.length;
  }

  remove(id: string): Promise<void> {
    return this.storage.remove(id);
  }

  clear(): Promise<void> {
    return this.storage.clear();
  }

  processNow(): Promise<void> {
    return this.processor.process();
  }

  isProcessing(): boolean {
    return this.processor.isProcessing();
  }

  pause(): void {
    this.processor.pause();
  }

  resume(): void {
    this.processor.resume();
  }

  isOnline(): Promise<boolean> {
    return this.networkManager.isOnline();
  }

  private async findActiveByUniqueKey(uniqueKey: string): Promise<QueuedRequest | null> {
    const all = await this.storage.getAll();
    return all.find((r) => r.uniqueKey === uniqueKey && r.status !== 'failed') ?? null;
  }

  private readonly executeRequest: QueueRequestExecutor = async (request) => {
    const policy = this.getPolicy();
    const result = await this.fetchAdapter.execute({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.data,
      timeout: request.timeout ?? this.getDefaultTimeout(),
      idempotencyKey: request.idempotencyKey,
      retryOnStatusCodes: request.retryOnStatusCodes ?? policy.retryOnStatusCodes,
    });
    return { status: result.status, data: result.data };
  };

  private readonly handleNetworkChange = (state: NetworkState): void => {
    this.events.emit('networkChange', state);
    const nowOnline = isOnlineState(state);

    if (nowOnline && this.lastOnline !== true) {
      this.logger.log('Network: online');
      this.processor.process().catch((error: unknown) => {
        this.logger.warn('Automatic queue processing failed', error);
      });
    } else if (!nowOnline) {
      this.logger.log('Network: offline');
    }

    this.lastOnline = nowOnline;
  };
}
