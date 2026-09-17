import { classifyThrownError } from '../errors/ErrorClassifier';
import { RetryError } from '../errors/RetryError';
import { generateRequestId } from '../utils/id';
/**
 * Executes a single immediate (non-queued) request, applying in-process
 * retry-with-backoff for transient failures (network blips, timeouts,
 * retryable server errors) via the RetryEngine. Never touches the persistent
 * queue — that decision is made by the caller based on the final result.
 */
export class RequestManager {
  constructor(deps) {
    this.fetchAdapter = deps.fetchAdapter;
    this.retryEngine = deps.retryEngine;
    this.onRetry = deps.onRetry;
  }
  async execute(options, policy) {
    const requestId = generateRequestId();
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
      const error = rawError instanceof RetryError ? rawError : classifyThrownError(rawError);
      return {
        ok: false,
        error
      };
    }
  }
}
//# sourceMappingURL=RequestManager.js.map