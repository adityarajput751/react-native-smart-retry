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

export type QueueRequestExecutor = (
  request: QueuedRequest,
  signal: AbortSignal
) => Promise<QueueRequestExecutionResult>;

export interface QueueProcessorOptions {
  storage: QueueStorage;
  networkManager: NetworkManager;
  executeRequest: QueueRequestExecutor;
  events: QueueEventEmitter;
  getPolicy: () => RetryPolicy;
  getMaxRequestAge?: () => number | undefined;
  logger: Logger;
}

/**
 * Processes the persistent queue strictly in FIFO order, one request at a
 * time. Guarantees only a single processing run is ever active and never
 * deletes a request from storage until its replay has actually succeeded.
 *
 * Delivery is at-least-once: a crash after the server handled a request but
 * before it was removed here replays that request.
 */
export class QueueProcessor {
  private readonly storage: QueueStorage;
  private readonly networkManager: NetworkManager;
  private readonly executeRequest: QueueRequestExecutor;
  private readonly events: QueueEventEmitter;
  private readonly getPolicy: () => RetryPolicy;
  private readonly getMaxRequestAge: () => number | undefined;
  private readonly logger: Logger;

  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private forceRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private current: { id: string; controller: AbortController } | null = null;
  /** Consecutive connectivity failures, driving backoff. Kept in memory: they never use up a request's retries. */
  private connectivityFailures = 0;
  private destroyed = false;
  private paused = false;

  constructor(options: QueueProcessorOptions) {
    this.storage = options.storage;
    this.networkManager = options.networkManager;
    this.executeRequest = options.executeRequest;
    this.events = options.events;
    this.getPolicy = options.getPolicy;
    this.getMaxRequestAge = options.getMaxRequestAge ?? (() => undefined);
    this.logger = options.logger;
  }

  /**
   * Runs a processing pass over the queue. Calls made during a run join it and
   * trigger one more pass when it ends, so anything added meanwhile is picked
   * up. `force` ignores backoff delays for that pass.
   */
  process(options?: { force?: boolean }): Promise<void> {
    if (options?.force) {
      this.forceRequested = true;
    }

    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }

    this.clearRetryTimer();
    this.inFlight = this.runUntilSettled().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  isProcessing(): boolean {
    return this.inFlight !== null;
  }

  /** Re-enables processing after {@link destroy}. */
  start(): void {
    this.destroyed = false;
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

  /** Cancels the in-flight replay, optionally only if it is for request `id`. */
  abortCurrent(id?: string): void {
    if (this.current && (id === undefined || this.current.id === id)) {
      this.current.controller.abort();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.paused = false;
    this.clearRetryTimer();
  }

  private async runUntilSettled(): Promise<void> {
    do {
      this.rerunRequested = false;
      const force = this.forceRequested;
      this.forceRequested = false;
      await this.run(force);
    } while (this.rerunRequested && !this.destroyed && !this.paused);
  }

  private async run(force: boolean): Promise<void> {
    if (this.paused) {
      this.logger.log('Skipping queue processing: paused');
      return;
    }

    const online = await this.networkManager.isOnline();
    if (!online) {
      this.logger.log('Skipping queue processing: offline');
      return;
    }

    await this.recoverInterrupted();

    const all = await this.storage.getAll();
    const pending = sortByCreatedAt(all.filter((request) => request.status === 'pending'));

    let started = false;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    const markStarted = (): void => {
      if (!started) {
        started = true;
        this.events.emit('queueStart', undefined);
        this.logger.log('Queue processing started');
      }
    };

    for (const { id } of pending) {
      if (this.destroyed || this.paused) {
        break;
      }

      // Re-read: the app may have removed or cleared this request during the run.
      const request = await this.storage.get(id);
      if (!request || request.status !== 'pending') {
        continue;
      }

      if (this.isExpired(request)) {
        markStarted();
        await this.expire(request);
        processed++;
        failed++;
        continue;
      }

      if (!force && request.nextAttemptAt && request.nextAttemptAt > Date.now()) {
        this.scheduleRetryTimer(request.nextAttemptAt - Date.now());
        break;
      }

      if (!(await this.networkManager.isOnline())) {
        this.logger.log('Network went offline mid-queue; stopping');
        break;
      }

      markStarted();
      this.logger.log(`Processing ${request.id}`);
      await this.storage.update(request.id, { status: 'processing', updatedAt: Date.now() });

      const controller = new AbortController();
      this.current = { id: request.id, controller };

      let response: QueueRequestExecutionResult;
      try {
        response = await this.executeRequest(request, controller.signal);
      } catch (rawError) {
        this.current = null;
        if (!(await this.storage.get(request.id))) {
          continue;
        }
        const outcome = await this.handleFailure(request, rawError);
        processed++;
        if (outcome === 'failed') {
          failed++;
          continue;
        }
        break;
      }

      this.current = null;
      this.connectivityFailures = 0;
      processed++;
      succeeded++;

      await this.storage.remove(request.id);
      this.logger.log('Request successful');
      this.logger.log(`Removed ${request.id}`);
      this.events.emit('success', { request, response: response.data });
    }

    if (started) {
      this.logger.log('Queue processing completed');
      this.events.emit('queueComplete', { processed, succeeded, failed });
    }
  }

  private async handleFailure(request: QueuedRequest, rawError: unknown): Promise<'stop' | 'failed'> {
    const error = rawError instanceof RetryError ? rawError : classifyThrownError(rawError);
    const policy = this.resolvePolicy(request);
    const lastError = serializeError(error);

    if (error.reason === 'ABORTED') {
      await this.storage.update(request.id, { status: 'pending', updatedAt: Date.now() });
      return 'stop';
    }

    if (error.isNetworkError || error.isTimeout) {
      this.logger.log('Request failed');
      await this.storage.update(request.id, { status: 'pending', updatedAt: Date.now(), lastError });
      this.connectivityFailures++;
      // The device can report "online" while the server is unreachable, in which
      // case no reconnect event will ever arrive to restart the queue.
      if (await this.networkManager.isOnline()) {
        this.scheduleRetryTimer(calculateDelay({ ...policy, attempt: this.connectivityFailures }));
      }
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
      const delay = calculateDelay({ ...policy, attempt: nextRetryCount, retryAfterMs: error.retryAfterMs });

      await this.storage.update(request.id, {
        status: 'pending',
        updatedAt: Date.now(),
        retryCount: nextRetryCount,
        lastError,
        nextAttemptAt: Date.now() + delay,
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

    await this.storage.update(request.id, { status: 'failed', updatedAt: Date.now(), lastError });
    this.events.emit('failure', { request, error: serializeError(error, { includeData: true }) });
    return 'failed';
  }

  private resolvePolicy(request: QueuedRequest): RetryPolicy {
    const policy = this.getPolicy();
    return {
      ...policy,
      strategy: request.strategy ?? policy.strategy,
      baseDelay: request.baseDelay ?? policy.baseDelay,
      maxDelay: request.maxDelay ?? policy.maxDelay,
    };
  }

  private isExpired(request: QueuedRequest): boolean {
    const maxAge = this.getMaxRequestAge();
    return maxAge !== undefined && Date.now() - request.createdAt > maxAge;
  }

  private async expire(request: QueuedRequest): Promise<void> {
    const error = serializeError(new RetryError({ message: 'Request expired', reason: 'EXPIRED' }));
    await this.storage.update(request.id, { status: 'failed', updatedAt: Date.now(), lastError: error });
    this.events.emit('failure', { request, error });
  }

  /**
   * Only one run is ever active and this is called at the start of one, so any
   * request still marked 'processing' was interrupted by a crash or app kill.
   */
  private async recoverInterrupted(): Promise<void> {
    const all = await this.storage.getAll();
    for (const request of all) {
      if (request.status === 'processing') {
        this.logger.warn(`Recovering interrupted request ${request.id}`);
        await this.storage.update(request.id, { status: 'pending', updatedAt: Date.now() });
      }
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
