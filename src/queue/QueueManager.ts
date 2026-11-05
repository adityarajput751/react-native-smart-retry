import type { RequestSender } from '../adapters/FetchAdapter';
import { RetryError } from '../errors/RetryError';
import type { NetworkManager } from '../network/NetworkManager';
import { isOnlineState } from '../network/NetworkState';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { QueueStorage } from '../storage/QueueStorage';
import type { NetworkState, QueuedRequest, QueueStatus, SmartRetryRequestOptions } from '../types';
import { isBinaryBody } from '../utils/body';
import type { Logger } from '../utils/logger';
import { QueueEventEmitter } from './QueueEvents';
import { createQueueItem, sortByCreatedAt } from './QueueItem';
import { QueueProcessor, type QueueRequestExecutor } from './QueueProcessor';

export interface QueueManagerOptions {
  storage: QueueStorage;
  networkManager: NetworkManager;
  send: RequestSender;
  events: QueueEventEmitter;
  logger: Logger;
  getPolicy: () => RetryPolicy;
  getDefaultTimeout: () => number;
  preventDuplicates: () => boolean;
  getTransformBeforePersist: () => ((request: QueuedRequest) => QueuedRequest) | undefined;
  getMaxQueueSize?: () => number | undefined;
  getMaxRequestAge?: () => number | undefined;
}

/**
 * Owns the persistent queue's lifecycle: duplicate protection on insert,
 * network-triggered auto-processing, and delegation to {@link QueueProcessor}
 * for the actual FIFO replay.
 */
export class QueueManager {
  private readonly storage: QueueStorage;
  private readonly networkManager: NetworkManager;
  private readonly send: RequestSender;
  private readonly events: QueueEventEmitter;
  private readonly logger: Logger;
  private readonly getPolicy: () => RetryPolicy;
  private readonly getDefaultTimeout: () => number;
  private readonly preventDuplicates: () => boolean;
  private readonly getTransformBeforePersist: () => ((request: QueuedRequest) => QueuedRequest) | undefined;
  private readonly getMaxQueueSize: () => number | undefined;
  private readonly processor: QueueProcessor;

  private unsubscribeNetwork: (() => void) | undefined;
  private lastOnline: boolean | null = null;
  private initialized = false;
  /** Inserts run one at a time, so the duplicate and size checks cannot race. */
  private insertChain: Promise<unknown> = Promise.resolve();

  constructor(options: QueueManagerOptions) {
    this.storage = options.storage;
    this.networkManager = options.networkManager;
    this.send = options.send;
    this.events = options.events;
    this.logger = options.logger;
    this.getPolicy = options.getPolicy;
    this.getDefaultTimeout = options.getDefaultTimeout;
    this.preventDuplicates = options.preventDuplicates;
    this.getTransformBeforePersist = options.getTransformBeforePersist;
    this.getMaxQueueSize = options.getMaxQueueSize ?? (() => undefined);

    this.processor = new QueueProcessor({
      storage: this.storage,
      networkManager: this.networkManager,
      executeRequest: this.executeRequest,
      events: this.events,
      getPolicy: this.getPolicy,
      getMaxRequestAge: options.getMaxRequestAge,
      logger: this.logger,
    });

    const notifyChanged = (): void => this.events.emit('queueChanged', undefined);
    this.events.on('queued', notifyChanged);
    this.events.on('success', notifyChanged);
    this.events.on('failure', notifyChanged);
    this.events.on('retry', notifyChanged);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.processor.start();

    this.unsubscribeNetwork = this.networkManager.subscribe(this.handleNetworkChange);
    this.networkManager.start();

    const online = await this.networkManager.isOnline();
    this.lastOnline = online;
    this.logger.log(`Network: ${online ? 'online' : 'offline'}`);

    // Not awaited: replaying the backlog can take minutes, and callers of
    // `initialize()` (every public API method) must not wait for that.
    if (online) {
      this.processInBackground('Initial queue processing failed');
    }
  }

  destroy(): void {
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = undefined;
    this.processor.destroy();
    this.initialized = false;
    this.lastOnline = null;
  }

  enqueue(
    options: SmartRetryRequestOptions,
    initial?: Pick<QueuedRequest, 'lastError' | 'nextAttemptAt'>
  ): Promise<QueuedRequest> {
    const inserted = this.insertChain.then(() => this.insert(options, initial));
    this.insertChain = inserted.catch(() => undefined);
    return inserted;
  }

  async getAll(): Promise<QueuedRequest[]> {
    return sortByCreatedAt(await this.storage.getAll());
  }

  async getCount(status?: QueueStatus): Promise<number> {
    const all = await this.storage.getAll();
    return status ? all.filter((request) => request.status === status).length : all.length;
  }

  /** Returns the live (pending or processing) request with this key, if any. */
  async findActiveByUniqueKey(uniqueKey: string): Promise<QueuedRequest | null> {
    const all = await this.storage.getAll();
    return all.find((r) => r.uniqueKey === uniqueKey && r.status !== 'failed') ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove(id);
    this.processor.abortCurrent(id);
    this.events.emit('queueChanged', undefined);
  }

  async clear(): Promise<void> {
    await this.storage.clear();
    this.processor.abortCurrent();
    this.events.emit('queueChanged', undefined);
  }

  /**
   * Returns `failed` requests to the back of the queue with a fresh retry
   * budget: just request `id`, or all of them. Resolves to how many were reset.
   */
  async retryFailed(id?: string): Promise<number> {
    const all = await this.storage.getAll();
    const failed = all.filter((r) => r.status === 'failed' && (id === undefined || r.id === id));

    for (const request of failed) {
      const now = Date.now();
      await this.storage.update(request.id, {
        status: 'pending',
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
        lastError: undefined,
        nextAttemptAt: undefined,
      });
    }

    if (failed.length > 0) {
      this.events.emit('queueChanged', undefined);
      this.processInBackground('Queue processing after retry failed');
    }
    return failed.length;
  }

  processNow(options?: { force?: boolean }): Promise<void> {
    return this.processor.process(options);
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

  private async insert(
    options: SmartRetryRequestOptions,
    initial?: Pick<QueuedRequest, 'lastError' | 'nextAttemptAt'>
  ): Promise<QueuedRequest> {
    if (isBinaryBody(options.data)) {
      throw new RetryError({
        message: 'FormData, Blob and ArrayBuffer bodies cannot be stored in the queue',
        reason: 'UNKNOWN',
      });
    }

    if (this.preventDuplicates() && options.uniqueKey) {
      const existing = await this.findActiveByUniqueKey(options.uniqueKey);
      if (existing) {
        this.logger.log(`Duplicate suppressed for uniqueKey (existing ${existing.id})`);
        return existing;
      }
    }

    await this.makeRoom();

    let item = createQueueItem(options, initial);
    const transform = this.getTransformBeforePersist();
    if (transform) {
      item = transform(item);
    }

    await this.storage.add(item);
    this.logger.log(`Queueing request ${item.id}`);
    this.events.emit('queued', item);
    this.processInBackground('Queue processing after enqueue failed');

    return item;
  }

  /** Enforces `maxQueueSize`, evicting the oldest failed request before refusing a new one. */
  private async makeRoom(): Promise<void> {
    const maxQueueSize = this.getMaxQueueSize();
    if (maxQueueSize === undefined) {
      return;
    }

    const all = await this.storage.getAll();
    if (all.length < maxQueueSize) {
      return;
    }

    const oldestFailed = sortByCreatedAt(all).find((request) => request.status === 'failed');
    if (!oldestFailed) {
      throw new RetryError({ message: `Queue is full (${maxQueueSize} requests)`, reason: 'QUEUE_FULL' });
    }
    await this.storage.remove(oldestFailed.id);
  }

  private processInBackground(failureMessage: string): void {
    this.processor.process().catch((error: unknown) => {
      this.logger.warn(failureMessage, error);
    });
  }

  private readonly executeRequest: QueueRequestExecutor = async (request, signal) => {
    const policy = this.getPolicy();
    const result = await this.send({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.data,
      timeout: request.timeout ?? this.getDefaultTimeout(),
      idempotencyKey: request.idempotencyKey,
      signal,
      retryOnStatusCodes: request.retryOnStatusCodes ?? policy.retryOnStatusCodes,
    });
    return { status: result.status, data: result.data };
  };

  private readonly handleNetworkChange = (state: NetworkState): void => {
    this.events.emit('networkChange', state);
    const nowOnline = isOnlineState(state);

    if (nowOnline && this.lastOnline !== true) {
      this.logger.log('Network: online');
      this.processInBackground('Automatic queue processing failed');
    } else if (!nowOnline) {
      this.logger.log('Network: offline');
    }

    this.lastOnline = nowOnline;
  };
}
