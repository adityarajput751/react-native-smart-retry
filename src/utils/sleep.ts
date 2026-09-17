/**
 * Resolves after `ms` milliseconds. Rejects immediately if `signal` is already
 * aborted, and rejects if it is aborted while waiting.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
