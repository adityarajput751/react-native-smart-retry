"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RequestManager = void 0;
var _ErrorClassifier = require("../errors/ErrorClassifier");
var _RetryError = require("../errors/RetryError");
var _id = require("../utils/id");
/**
 * Executes a single immediate (non-queued) request, applying in-process
 * retry-with-backoff for transient failures (network blips, timeouts,
 * retryable server errors) via the RetryEngine. Never touches the persistent
 * queue — that decision is made by the caller based on the final result.
 */
class RequestManager {
  constructor(deps) {
    this.fetchAdapter = deps.fetchAdapter;
    this.retryEngine = deps.retryEngine;
    this.onRetry = deps.onRetry;
  }
  async execute(options, policy) {
    const requestId = (0, _id.generateRequestId)();
    try {
      const response = await this.retryEngine.executeWithRetry(() => this.fetchAdapter.execute({
        url: options.url,
        method: options.method,
        headers: options.headers,
        data: options.data,
        timeout: options.timeout,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
        retryOnStatusCodes: policy.retryOnStatusCodes
      }), {
        requestId,
        method: options.method,
        policy,
        signal: options.signal,
        onRetry: this.onRetry,
        retryConnectivityErrors: false
      });
      return {
        ok: true,
        response
      };
    } catch (rawError) {
      const error = rawError instanceof _RetryError.RetryError ? rawError : (0, _ErrorClassifier.classifyThrownError)(rawError);
      return {
        ok: false,
        error
      };
    }
  }
}
exports.RequestManager = RequestManager;
//# sourceMappingURL=RequestManager.js.map