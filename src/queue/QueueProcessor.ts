import { classifyThrownError, isRetryable, serializeError } from '../errors/ErrorClassifier';
import { RetryError } from '../errors/RetryError';
import type { NetworkManager } from '../network/NetworkManager';
import { calculateDelay } from '../retry/calculateDelay';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { QueuedRequest } from '../types';
import { Logger } from '../utils/logger';
import type { QueueEventEmitter } from './QueueEvents';
import { sortByCreatedAt } from './QueueItem';
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
export class QueueProcessor {
  private readonly storage: QueueStorage;
  private readonly networkManager: NetworkManager;
  private readonly executeRequest: QueueRequestExecutor;
  private readonly events: QueueEventEmitter;
  private readonly getPolicy: () => RetryPolicy;
  private readonly staleProcessingThresholdMs: number;
  private readonly logger: Logger;

  private inFlight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private paused = false;

  constructor(options: QueueProcessorOptions) {
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
  process(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.clearRetryTimer();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  isProcessing(): boolean {
    return this.inFlight !== null;
  }

  pause(): void {
    this.paused = true;
    this.logger.log('Queue paused (app backgrounded)');
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.logger.log('Queue resumed (app foregrounded)');
  }

  destroy(): void {
    this.destroyed = true;
    this.clearRetryTimer();
  }

  private async run(): Promise<void> {
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
    const pending = sortByCreatedAt(all.filter((request) => request.status === 'pending'));

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
      await this.storage.update(request.id, { status: 'processing', updatedAt: Date.now() });

      try {
        const result = await this.executeRequest(request);
        await this.storage.remove(request.id);
        this.logger.log('Request successful');
        this.logger.log(`Removed ${request.id}`);
        this.events.emit('success', { request, response: result.data });
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
    this.events.emit('queueComplete', { processed, succeeded, failed });
  }

  private async handleFailure(
    request: QueuedRequest,
    rawError: unknown
  ): Promise<'continue' | 'stop' | 'failed'> {
    const error = rawError instanceof RetryError ? rawError : classifyThrownError(rawError);
    const policy = this.getPolicy();

    if (error.isNetworkError || error.isTimeout) {
      this.logger.log('Request failed');
      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: Date.now(),
        lastError: serializeError(error),
      });
      return 'stop';
    }

    const effectiveMaxRetries = request.maxRetries ?? policy.retries;
    const effectiveStatusCodes = request.retryOnStatusCodes ?? policy.retryOnStatusCodes;
    // Method-safety gating (retryMethods) intentionally does not apply here: a request only ever
    // reaches the persistent queue because the caller explicitly opted in with `queue: true`, which
    // already is the "explicit configuration" unsafe methods require (see RetryEngine for the
    // immediate, non-queued path, where that gate still applies).
    const canRetry =
      isRetryable(error, { retryOnStatusCodes: effectiveStatusCodes }) &&
      request.retryCount < effectiveMaxRetries;

    if (canRetry) {
      const nextRetryCount = request.retryCount + 1;
      const delay = calculateDelay({
        attempt: nextRetryCount,
        strategy: policy.strategy,
        baseDelay: policy.baseDelay,
        maxDelay: policy.maxDelay,
        retryAfterMs: error.retryAfterMs,
      });
      const nextAttemptAt = Date.now() + delay;

      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: Date.now(),
        retryCount: nextRetryCount,
        lastError: serializeError(error),
        nextAttemptAt,
      });

      this.events.emit('retry', {
        requestId: request.id,
        attempt: nextRetryCount,
        maxRetries: effectiveMaxRetries,
        reason: error.reason,
        delay,
      });

      this.scheduleRetryTimer(delay);
      return 'stop';
    }

    await this.storage.update(request.id, {
      status: 'failed',
      updatedAt: Date.now(),
      lastError: serializeError(error),
    });
    this.events.emit('failure', { request, error: serializeError(error) });
    return 'failed';
  }

  private async recoverStaleProcessing(): Promise<void> {
    const all = await this.storage.getAll();
    const now = Date.now();
    const stale = all.filter(
      (request) =>
        request.status === 'processing' && now - request.updatedAt > this.staleProcessingThresholdMs
    );

    for (const request of stale) {
      this.logger.warn(`Recovering stale processing request ${request.id}`);
      await this.storage.update(request.id, { status: 'pending', updatedAt: now });
    }
  }

  private scheduleRetryTimer(delay: number): void {
    this.clearRetryTimer();
    if (this.destroyed) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.process().catch((error: unknown) => {
        this.logger.warn('Scheduled retry processing failed', error);
      });
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
