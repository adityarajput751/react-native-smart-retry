/**
 * Minimal debug logger. Disabled by default. Never logs headers or request
 * bodies — only ids, urls, methods, and status/error metadata — so enabling
 * `debug` cannot leak tokens, cookies, or payloads into device logs.
 */
export declare class Logger {
    private enabled;
    constructor(enabled?: boolean);
    setEnabled(enabled: boolean): void;
    log(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map