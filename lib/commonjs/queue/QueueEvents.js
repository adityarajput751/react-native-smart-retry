"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.QueueEventEmitter = void 0;
/** Small internal typed event emitter used to bridge queue/network activity to configured callbacks. */
class QueueEventEmitter {
  listeners = new Map();
  on(event, listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    set.forEach(listener => listener(payload));
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
exports.QueueEventEmitter = QueueEventEmitter;
//# sourceMappingURL=QueueEvents.js.map