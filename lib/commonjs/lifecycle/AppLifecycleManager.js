"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.AppLifecycleManager = void 0;
exports.createDefaultAppState = createDefaultAppState;
var _logger = require("../utils/logger");
/** The subset of React Native's `AppState` this manager depends on. */

/**
 * Wraps React Native's `AppState` to expose a normalized active/background
 * signal, so the queue processor can pause while the app is backgrounded
 * (see `pauseWhenBackgrounded`) without depending on `AppState` directly.
 */
class AppLifecycleManager {
  subscription = null;
  listeners = new Set();
  constructor(appState) {
    this.appState = appState;
  }
  start() {
    if (this.subscription) {
      return;
    }
    this.subscription = this.appState.addEventListener('change', state => {
      this.notify(normalize(state));
    });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getCurrentState() {
    return normalize(this.appState.currentState);
  }

  /**
   * Stops listening to OS AppState changes. Internal listeners registered via
   * `subscribe()` are kept intact (not cleared) so a later `start()` call —
   * e.g. after `SmartRetry.destroy()` followed by `SmartRetry.initialize()` —
   * resumes delivering events to the same subscribers without needing them to
   * re-subscribe.
   */
  destroy() {
    if (this.subscription) {
      if (typeof this.subscription === 'function') {
        this.subscription();
      } else {
        this.subscription.remove();
      }
      this.subscription = null;
    }
  }
  notify(state) {
    this.listeners.forEach(listener => listener(state));
  }
}
exports.AppLifecycleManager = AppLifecycleManager;
function normalize(state) {
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
function createDefaultAppState() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      AppState
    } = require('react-native');
    if (AppState && typeof AppState.addEventListener === 'function') {
      return AppState;
    }
    return null;
  } catch (error) {
    _logger.logger.warn('react-native AppState is not available; pauseWhenBackgrounded will have no effect.', error);
    return null;
  }
}
//# sourceMappingURL=AppLifecycleManager.js.map