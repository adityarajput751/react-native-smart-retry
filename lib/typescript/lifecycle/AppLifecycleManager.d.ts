export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'unknown';
/** The subset of React Native's `AppState` this manager depends on. */
export interface AppStateLike {
    currentState: string;
    addEventListener(type: 'change', listener: (state: string) => void): {
        remove(): void;
    } | (() => void);
}
/**
 * Wraps React Native's `AppState` to expose a normalized active/background
 * signal, so the queue processor can pause while the app is backgrounded
 * (see `pauseWhenBackgrounded`) without depending on `AppState` directly.
 */
export declare class AppLifecycleManager {
    private readonly appState;
    private subscription;
    private readonly listeners;
    constructor(appState: AppStateLike);
    start(): void;
    subscribe(listener: (state: AppLifecycleState) => void): () => void;
    getCurrentState(): AppLifecycleState;
    /**
     * Stops listening to OS AppState changes. Internal listeners registered via
     * `subscribe()` are kept intact (not cleared) so a later `start()` call —
     * e.g. after `SmartRetry.destroy()` followed by `SmartRetry.initialize()` —
     * resumes delivering events to the same subscribers without needing them to
     * re-subscribe.
     */
    destroy(): void;
    private notify;
}
/**
 * Attempts to load React Native's `AppState`. Returns null outside a React
 * Native runtime (e.g. plain Node during tests) so lifecycle pausing simply
 * becomes a no-op rather than throwing.
 */
export declare function createDefaultAppState(): AppStateLike | null;
//# sourceMappingURL=AppLifecycleManager.d.ts.map