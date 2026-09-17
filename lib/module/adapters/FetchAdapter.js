import { classifyStatusError, classifyThrownError, parseRetryAfter } from '../errors/ErrorClassifier';
const DEFAULT_TIMEOUT_MS = 15000;
const BODYLESS_METHODS = ['GET', 'HEAD'];

/**
 * Executes HTTP requests using the platform's global `fetch`. Kept as a thin,
 * swappable adapter so the core request/queue/retry logic never depends on
 * fetch directly.
 */
export class FetchAdapter {
  async execute(request) {
    const controller = new AbortController();
    const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let onExternalAbort;
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        onExternalAbort = () => controller.abort();
        request.signal.addEventListener('abort', onExternalAbort, {
          once: true
        });
      }
    }
    const headers = {
      ...request.headers
    };
    if (request.idempotencyKey && !this.hasHeader(headers, 'Idempotency-Key')) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }
    let body;
    if (request.data !== undefined && !BODYLESS_METHODS.includes(request.method)) {
      body = typeof request.data === 'string' ? request.data : JSON.stringify(request.data);
      if (!this.hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    let response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers,
        body,
        signal: controller.signal
      });
    } catch (error) {
      throw classifyThrownError(error, {
        wasTimeout: timedOut
      });
    } finally {
      clearTimeout(timeoutHandle);
      if (onExternalAbort) {
        request.signal?.removeEventListener('abort', onExternalAbort);
      }
    }
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      throw classifyStatusError(response.status, {
        retryOnStatusCodes: request.retryOnStatusCodes,
        retryAfterMs: retryAfterMs ?? undefined,
        statusText: response.statusText
      });
    }
    const data = await this.parseBody(response);
    return {
      status: response.status,
      headers: responseHeaders,
      data
    };
  }
  hasHeader(headers, name) {
    const lower = name.toLowerCase();
    return Object.keys(headers).some(key => key.toLowerCase() === lower);
  }
  async parseBody(response) {
    if (response.status === 204) {
      return undefined;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    const text = await response.text();
    return text;
  }
}
//# sourceMappingURL=FetchAdapter.js.map