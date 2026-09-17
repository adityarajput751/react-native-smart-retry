import { logger as fallbackLogger } from '../utils/logger';

export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'unknown';

/** The subset of React Native's `AppState` this manager depends on. */
export interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void } | (() => void);
}

/**
 * Wraps React Native's `AppState` to expose a normalized active/background
 * signal, so the queue processor can pause while the app is backgrounded
 * (see `pauseWhenBackgrounded`) without depending on `AppState` directly.
 */
export class AppLifecycleManager {
  private readonly appState: AppStateLike;
  private subscription: { remove(): void } | (() => void) | null = null;
  private readonly listeners = new Set<(state: AppLifecycleState) => void>();

  constructor(appState: AppStateLike) {
    this.appState = appState;
  }

  start(): void {
    if (this.subscription) {
      return;
    }
    this.subscription = this.appState.addEventListener('change', (state) => {
      this.notify(normalize(state));
    });
  }

  subscribe(listener: (state: AppLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCurrentState(): AppLifecycleState {
    return normalize(this.appState.currentState);
  }

  /**
   * Stops listening to OS AppState changes. Internal listeners registered via
   * `subscribe()` are kept intact (not cleared) so a later `start()` call —
   * e.g. after `SmartRetry.destroy()` followed by `SmartRetry.initialize()` —
   * resumes delivering events to the same subscribers without needing them to
   * re-subscribe.
   */
  destroy(): void {
    if (this.subscription) {
      if (typeof this.subscription === 'function') {
        this.subscription();
      } else {
        this.subscription.remove();
      }
      this.subscription = null;
    }
  }

  private notify(state: AppLifecycleState): void {
    this.listeners.forEach((listener) => listener(state));
  }
}

function normalize(state: string): AppLifecycleState {
  if (state === 'active' || state === 'background' || state === 'inactive') {
    return state;
  }
  return 'unknown';
}

/**
 * Attempts to load React Native's `AppState`. Returns null outside a React
 * Native runtime (e.g. plain Node during tests) so lifecycle pausing simply
 * becomes a no-op rather than throwing.
 */
export function createDefaultAppState(): AppStateLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppState } = require('react-native');
    if (AppState && typeof AppState.addEventListener === 'function') {
      return AppState as AppStateLike;
    }
    return null;
  } catch (error) {
    fallbackLogger.warn(
      'react-native AppState is not available; pauseWhenBackgrounded will have no effect.',
      error
    );
    return null;
  }
}
