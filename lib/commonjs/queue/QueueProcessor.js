"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.QueueProcessor = void 0;
var _ErrorClassifier = require("../errors/ErrorClassifier");
var _RetryError = require("../errors/RetryError");
var _calculateDelay = require("../retry/calculateDelay");
var _QueueItem = require("./QueueItem");
/**
 * Processes the persistent queue strictly in FIFO order, one request at a
 * time. Guarantees only a single processing run is ever active (concurrent
 * `process()` calls attach to the in-flight run) and never deletes a request
 * from storage until its replay has actually succeeded.
 */
class QueueProcessor {
  inFlight = null;
  retryTimer = null;
  destroyed = false;
  paused = false;
  constructor(options) {
    this.storage = options.storage;
    this.networkManager = options.networkManager;
    this.executeRequest = options.executeRequest;
    this.events = options.events;
    this.getPolicy = options.getPolicy;
    this.staleProcessingThresholdMs = options.staleProcessingThresholdMs;
    this.logger = options.logger;
  }

  /**
   * Runs (or attaches to) a single processing pass over the queue. Concurrent
   * calls never spawn a second processor — they resolve once the in-flight
   * run completes.
   */
  process() {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.clearRetryTimer();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  isProcessing() {
    return this.inFlight !== null;
  }
  pause() {
    this.paused = true;
    this.logger.log('Queue paused (app backgrounded)');
  }
  resume() {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.logger.log('Queue resumed (app foregrounded)');
  }
  destroy() {
    this.destroyed = true;
    this.clearRetryTimer();
  }
  async run() {
    if (this.paused) {
      this.logger.log('Skipping queue processing: paused');
      return;
    }
    const online = await this.networkManager.isOnline();
    if (!online) {
      this.logger.log('Skipping queue processing: offline');
      return;
    }
    await this.recoverStaleProcessing();
    const all = await this.storage.getAll();
    const pending = (0, _QueueItem.sortByCreatedAt)(all.filter(request => request.status === 'pending'));
    if (pending.length === 0) {
      return;
    }
    this.events.emit('queueStart', undefined);
    this.logger.log('Queue processing started');
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const request of pending) {
      if (this.destroyed || this.paused) {
        break;
      }
      if (request.nextAttemptAt && request.nextAttemptAt > Date.now()) {
        this.scheduleRetryTimer(request.nextAttemptAt - Date.now());
        break;
      }
      if (!(await this.networkManager.isOnline())) {
        this.logger.log('Network went offline mid-queue; stopping');
        break;
      }
      this.logger.log(`Processing ${request.id}`);
      await this.storage.update(request.id, {
        status: 'processing',
        updatedAt: Date.now()
      });
      try {
        const result = await this.executeRequest(request);
        await this.storage.remove(request.id);
        this.logger.log('Request successful');
        this.logger.log(`Removed ${request.id}`);
        this.events.emit('success', {
          request,
          response: result.data
        });
        processed++;
        succeeded++;
      } catch (rawError) {
        const outcome = await this.handleFailure(request, rawError);
        processed++;
        if (outcome === 'failed') {
          failed++;
        }
        if (outcome === 'stop') {
          break;
        }
      }
    }
    this.logger.log('Queue processing completed');
    this.events.emit('queueComplete', {
      processed,
      succeeded,
      failed
    });
  }
  async handleFailure(request, rawError) {
    const error = rawError instanceof _RetryError.RetryError ? rawError : (0, _ErrorClassifier.classifyThrownError)(rawError);
    const policy = this.getPolicy();
    if (error.isNetworkError || error.isTimeout) {
      this.logger.log('Request failed');
      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: Date.now(),
        lastError: (0, _ErrorClassifier.serializeError)(error)
      });
      return 'stop';
    }
    const effectiveMaxRetries = request.maxRetries ?? policy.retries;
    const effectiveStatusCodes = request.retryOnStatusCodes ?? policy.retryOnStatusCodes;
    // Method-safety gating (retryMethods) intentionally does not apply here: a request only ever
    // reaches the persistent queue because the caller explicitly opted in with `queue: true`, which
    // already is the "explicit configuration" unsafe methods require (see RetryEngine for the
    // immediate, non-queued path, where that gate still applies).
    const canRetry = (0, _ErrorClassifier.isRetryable)(error, {
      retryOnStatusCodes: effectiveStatusCodes
    }) && request.retryCount < effectiveMaxRetries;
    if (canRetry) {
      const nextRetryCount = request.retryCount + 1;
      const delay = (0, _calculateDelay.calculateDelay)({
        attempt: nextRetryCount,
        strategy: policy.strategy,
        baseDelay: policy.baseDelay,
        maxDelay: policy.maxDelay,
        retryAfterMs: error.retryAfterMs
      });
      const nextAttemptAt = Date.now() + delay;
      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: Date.now(),
        retryCount: nextRetryCount,
        lastError: (0, _ErrorClassifier.serializeError)(error),
        nextAttemptAt
      });
      this.events.emit('retry', {
        requestId: request.id,
        attempt: nextRetryCount,
        maxRetries: effectiveMaxRetries,
        reason: error.reason,
        delay
      });
      this.scheduleRetryTimer(delay);
      return 'stop';
    }
    await this.storage.update(request.id, {
      status: 'failed',
      updatedAt: Date.now(),
      lastError: (0, _ErrorClassifier.serializeError)(error)
    });
    this.events.emit('failure', {
      request,
      error: (0, _ErrorClassifier.serializeError)(error)
    });
    return 'failed';
  }
  async recoverStaleProcessing() {
    const all = await this.storage.getAll();
    const now = Date.now();
    const stale = all.filter(request => request.status === 'processing' && now - request.updatedAt > this.staleProcessingThresholdMs);
    for (const request of stale) {
      this.logger.warn(`Recovering stale processing request ${request.id}`);
      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: now
      });
    }
  }
  scheduleRetryTimer(delay) {
    this.clearRetryTimer();
    if (this.destroyed) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.process().catch(error => {
        this.logger.warn('Scheduled retry processing failed', error);
      });
    }, delay);
  }
  clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
exports.QueueProcessor = QueueProcessor;
//# sourceMappingURL=QueueProcessor.js.map