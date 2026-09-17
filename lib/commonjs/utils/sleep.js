"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.sleep = sleep;
/**
 * Resolves after `ms` milliseconds. Rejects immediately if `signal` is already
 * aborted, and rejects if it is aborted while waiting.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, {
      once: true
    });
  });
}
//# sourceMappingURL=sleep.js.map