import type { NetworkListener, NetworkState } from '../types';
import { logger } from '../utils/logger';
import { isOnlineState, UNKNOWN_NETWORK_STATE } from './NetworkState';

/**
 * Pluggable connectivity source. The default implementation (see
 * `createDefaultNetworkMonitor`) wraps `@react-native-community/netinfo`;
 * tests and alternative platforms can supply their own.
 */
export interface NetworkMonitor {
  fetch(): Promise<NetworkState>;
  /** Returns an unsubscribe function. Must not be a polling implementation. */
  addEventListener(listener: (state: NetworkState) => void): () => void;
}

/**
 * Tracks connectivity state via a push-based `NetworkMonitor` (no polling),
 * exposes the current state, and lets callers wait for connectivity to
 * return — the signal `QueueManager` uses to automatically resume processing.
 */
export class NetworkManager {
  private readonly monitor: NetworkMonitor;
  private readonly listeners = new Set<NetworkListener>();
  private waiters: Array<() => void> = [];
  private currentState: NetworkState | null = null;
  private unsubscribeMonitor: (() => void) | undefined;

  constructor(monitor: NetworkMonitor) {
    this.monitor = monitor;
  }

  /** Begins listening for connectivity changes. Safe to call more than once. */
  start(): void {
    if (this.unsubscribeMonitor) {
      return;
    }

    this.unsubscribeMonitor = this.monitor.addEventListener((state) => {
      this.handleStateChange(state);
    });

    this.monitor
      .fetch()
      .then((state) => {
        // Discard this seed result if a push event already arrived first (e.g. the
        // monitor emitted a change while this fetch() was still in flight) — the
        // event is fresher and must win, not be clobbered by a stale fetch reply.
        if (this.currentState === null) {
          this.handleStateChange(state);
        }
      })
      .catch((error: unknown) => {
        logger.warn('Failed to fetch initial network state', error);
      });
  }

  async isOnline(): Promise<boolean> {
    if (this.currentState) {
      return isOnlineState(this.currentState);
    }
    try {
      const state = await this.monitor.fetch();
      // Only cache while subscribed: nothing would update the cached value otherwise.
      if (this.unsubscribeMonitor) {
        this.currentState = state;
      }
      return isOnlineState(state);
    } catch (error) {
      logger.warn('Failed to determine network state; assuming online.', error);
      return isOnlineState(UNKNOWN_NETWORK_STATE);
    }
  }

  /** Subscribes to connectivity changes. Returns an unsubscribe function. */
  subscribe(listener: NetworkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves the next time the device transitions to (or already is) online. */
  async waitUntilOnline(): Promise<void> {
    if (await this.isOnline()) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  destroy(): void {
    this.unsubscribeMonitor?.();
    this.unsubscribeMonitor = undefined;
    this.listeners.clear();
    this.waiters = [];
    this.currentState = null;
  }

  private handleStateChange(state: NetworkState): void {
    const wasOnline = this.currentState ? isOnlineState(this.currentState) : null;
    this.currentState = state;
    const nowOnline = isOnlineState(state);

    this.listeners.forEach((listener) => listener(state));

    if (nowOnline && wasOnline !== true) {
      const pendingWaiters = this.waiters;
      this.waiters = [];
      pendingWaiters.forEach((resolve) => resolve());
    }
  }
}

/**
 * Builds the default monitor for React Native, backed by
 * `@react-native-community/netinfo` when it is installed. NetInfo is an
 * optional peer dependency — if it isn't present, falls back to an
 * always-online monitor with no event source, so `SmartRetry` still functions
 * (connectivity is then only discovered by requests actually failing).
 */
export function createDefaultNetworkMonitor(): NetworkMonitor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const NetInfo = require('@react-native-community/netinfo').default;
    return {
      async fetch(): Promise<NetworkState> {
        const state = await NetInfo.fetch();
        return {
          isConnected: Boolean(state.isConnected),
          isInternetReachable: state.isInternetReachable,
        };
      },
      addEventListener(listener: (state: NetworkState) => void): () => void {
        return NetInfo.addEventListener(
          (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
            listener({
              isConnected: Boolean(state.isConnected),
              isInternetReachable: state.isInternetReachable,
            });
          }
        );
      },
    };
  } catch {
    let warned = false;
    return {
      async fetch(): Promise<NetworkState> {
        // Warned here rather than at construction, which runs before `configure({ debug })`.
        if (!warned) {
          warned = true;
          logger.warn(
            '@react-native-community/netinfo is not installed; falling back to an always-online monitor. ' +
              'Install it for automatic offline detection and sync-on-reconnect.'
          );
        }
        return { isConnected: true, isInternetReachable: null };
      },
      addEventListener(): () => void {
        return () => undefined;
      },
    };
  }
}
