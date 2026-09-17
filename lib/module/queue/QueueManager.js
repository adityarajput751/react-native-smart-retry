import { isOnlineState } from '../network/NetworkState';
import { createQueueItem } from './QueueItem';
import { QueueProcessor } from './QueueProcessor';
/**
 * Owns the persistent queue's lifecycle: duplicate protection on insert,
 * network-triggered auto-processing, and delegation to {@link QueueProcessor}
 * for the actual FIFO replay.
 */
export class QueueManager {
  lastOnline = null;
  initialized = false;
  constructor(options) {
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
      logger: this.logger
    });
  }
  async initialize() {
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
  destroy() {
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = undefined;
    this.processor.destroy();
    this.initialized = false;
    this.lastOnline = null;
  }
  async enqueue(options) {
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
    this.processor.process().catch(error => {
      this.logger.warn('Queue processing after enqueue failed', error);
    });
    return item;
  }
  getAll() {
    return this.storage.getAll();
  }
  async getCount() {
    const all = await this.storage.getAll();
    return all.length;
  }
  remove(id) {
    return this.storage.remove(id);
  }
  clear() {
    return this.storage.clear();
  }
  processNow() {
    return this.processor.process();
  }
  isProcessing() {
    return this.processor.isProcessing();
  }
  pause() {
    this.processor.pause();
  }
  resume() {
    this.processor.resume();
  }
  isOnline() {
    return this.networkManager.isOnline();
  }
  async findActiveByUniqueKey(uniqueKey) {
    const all = await this.storage.getAll();
    return all.find(r => r.uniqueKey === uniqueKey && r.status !== 'failed') ?? null;
  }
  executeRequest = async request => {
    const policy = this.getPolicy();
    const result = await this.fetchAdapter.execute({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.data,
      timeout: request.timeout ?? this.getDefaultTimeout(),
      idempotencyKey: request.idempotencyKey,
      retryOnStatusCodes: request.retryOnStatusCodes ?? policy.retryOnStatusCodes
    });
    return {
      status: result.status,
      data: result.data
    };
  };
  handleNetworkChange = state => {
    this.events.emit('networkChange', state);
    const nowOnline = isOnlineState(state);
    if (nowOnline && this.lastOnline !== true) {
      this.logger.log('Network: online');
      this.processor.process().catch(error => {
        this.logger.warn('Automatic queue processing failed', error);
      });
    } else if (!nowOnline) {
      this.logger.log('Network: offline');
    }
    this.lastOnline = nowOnline;
  };
}
//# sourceMappingURL=QueueManager.js.map