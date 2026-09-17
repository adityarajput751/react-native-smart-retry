export type FetchOutcome =
  | { type: 'response'; status: number; body?: unknown; headers?: Record<string, string> }
  | { type: 'network-error' }
  | { type: 'hang' };

/**
 * Installs a scripted `global.fetch` mock. Each call consumes the next
 * outcome in `outcomes` (or the last one, if the script is shorter than the
 * number of calls made). Returns the underlying jest mock plus a `calls`
 * helper for assertions.
 */
export function installMockFetch(outcomes: FetchOutcome[]): jest.Mock {
  let index = 0;

  const mock = jest.fn((_url: string, init?: RequestInit) => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index++;

    if (outcome.type === 'network-error') {
      return Promise.reject(new TypeError('Network request failed'));
    }

    if (outcome.type === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    }

    const headers = { 'content-type': 'application/json', ...outcome.headers };
    const body = outcome.body !== undefined ? JSON.stringify(outcome.body) : undefined;
    return Promise.resolve(
      new Response(body, {
        status: outcome.status,
        headers,
      })
    );
  });

  (global as unknown as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;
  return mock;
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
