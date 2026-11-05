/**
 * Minimal debug logger. Disabled by default. Never logs headers or request
 * bodies — only ids, urls, methods, and status/error metadata — so enabling
 * `debug` cannot leak tokens, cookies, or payloads into device logs.
 */
export class Logger {
  private enabled: boolean;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  log(message: string, ...meta: unknown[]): void {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[SmartRetry] ${message}`, ...meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[SmartRetry] ${message}`, ...meta);
  }

  /** Always printed, even with `debug` off: reserved for problems the app must fix. */
  error(message: string, ...meta: unknown[]): void {
    // eslint-disable-next-line no-console
    console.error(`[SmartRetry] ${message}`, ...meta);
  }
}

export const logger = new Logger(false);
