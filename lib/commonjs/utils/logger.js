"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.logger = exports.Logger = void 0;
/**
 * Minimal debug logger. Disabled by default. Never logs headers or request
 * bodies — only ids, urls, methods, and status/error metadata — so enabling
 * `debug` cannot leak tokens, cookies, or payloads into device logs.
 */
class Logger {
  constructor(enabled = false) {
    this.enabled = enabled;
  }
  setEnabled(enabled) {
    this.enabled = enabled;
  }
  log(message, ...meta) {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[SmartRetry] ${message}`, ...meta);
  }
  warn(message, ...meta) {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[SmartRetry] ${message}`, ...meta);
  }
  error(message, ...meta) {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[SmartRetry] ${message}`, ...meta);
  }
}
exports.Logger = Logger;
const logger = exports.logger = new Logger(false);
//# sourceMappingURL=logger.js.map