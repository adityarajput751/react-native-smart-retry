/**
 * A tiny in-memory "backend" so the example app demonstrates offline queueing
 * and sync without needing a real server. It intercepts `fetch` calls whose
 * URL starts with `MOCK_API_BASE_URL` and simulates latency, forced offline
 * mode (toggled from the demo screen), and a configurable random failure
 * rate. Any other URL passes through to the real `fetch`.
 */

export const MOCK_API_BASE_URL = 'https://mock.smart-retry.example';

export interface MockApiController {
  isForcedOffline(): boolean;
  setForcedOffline(offline: boolean): void;
  setFailureRate(rate: number): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function installMockApi(): MockApiController {
  const originalFetch = global.fetch.bind(global);
  let forcedOffline = false;
  let failureRate = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (!url.startsWith(MOCK_API_BASE_URL)) {
      return originalFetch(input, init);
    }

    await delay(300 + Math.random() * 400);

    if (forcedOffline) {
      throw new TypeError('Network request failed');
    }

    if (Math.random() < failureRate) {
      return new Response(JSON.stringify({ message: 'Simulated server error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }

    return new Response(
      JSON.stringify({ ok: true, receivedAt: Date.now(), method: init?.method ?? 'GET', body }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  global.fetch = mockFetch;

  return {
    isForcedOffline: () => forcedOffline,
    setForcedOffline: (offline: boolean) => {
      forcedOffline = offline;
    },
    setFailureRate: (rate: number) => {
      failureRate = Math.min(1, Math.max(0, rate));
    },
  };
}
