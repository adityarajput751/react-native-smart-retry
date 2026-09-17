import type { NetworkListener, NetworkState } from '../types';
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
export declare class NetworkManager {
    private readonly monitor;
    private readonly listeners;
    private waiters;
    private currentState;
    private unsubscribeMonitor;
    constructor(monitor: NetworkMonitor);
    /** Begins listening for connectivity changes. Safe to call more than once. */
    start(): void;
    isOnline(): Promise<boolean>;
    /** Subscribes to connectivity changes. Returns an unsubscribe function. */
    subscribe(listener: NetworkListener): () => void;
    /** Resolves the next time the device transitions to (or already is) online. */
    waitUntilOnline(): Promise<void>;
    destroy(): void;
    private handleStateChange;
}
/**
 * Builds the default monitor for React Native, backed by
 * `@react-native-community/netinfo` when it is installed. NetInfo is an
 * optional peer dependency — if it isn't present, falls back to an
 * always-online monitor with no event source, so `SmartRetry` still functions
 * (connectivity is then only discovered by requests actually failing).
 */
export declare function createDefaultNetworkMonitor(): NetworkMonitor;
//# sourceMappingURL=NetworkManager.d.ts.map