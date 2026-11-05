import { logger } from '../utils/logger';
import type { NetworkState, QueuedRequest, RetryInfo, SerializedError } from '../types';

export interface QueueEventMap {
  queued: QueuedRequest;
  retry: RetryInfo;
  success: { request: QueuedRequest; response: unknown };
  failure: { request: QueuedRequest; error: SerializedError };
  queueStart: undefined;
  queueComplete: { processed: number; succeeded: number; failed: number };
  networkChange: NetworkState;
  /** The stored queue changed: a request was added, removed, rescheduled, or finished. */
  queueChanged: undefined;
}

type EventListener<T> = (payload: T) => void;

/** Small internal typed event emitter used to bridge queue/network activity to configured callbacks. */
export class QueueEventEmitter {
  private readonly listeners = new Map<keyof QueueEventMap, Set<EventListener<never>>>();

  on<K extends keyof QueueEventMap>(event: K, listener: EventListener<QueueEventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as EventListener<never>);
    return () => {
      set?.delete(listener as EventListener<never>);
    };
  }

  emit<K extends keyof QueueEventMap>(event: K, payload: QueueEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    // A throwing listener is an app bug. It must never change the outcome of the
    // queue operation that emitted the event, so isolate it and report it.
    set.forEach((listener) => {
      try {
        (listener as EventListener<QueueEventMap[K]>)(payload);
      } catch (error) {
        logger.error(`Listener for "${String(event)}" threw`, error);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
