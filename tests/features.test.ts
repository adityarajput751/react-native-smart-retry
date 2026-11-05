import {
  createSmartRetry,
  type SmartRetryClient,
  type SmartRetryClientOptions,
} from '../src/core/SmartRetry';
import { AppLifecycleManager, type AppStateLike } from '../src/lifecycle/AppLifecycleManager';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';
import { installMockFetch } from './helpers/mockFetch';

const URL = 'https://api.example.com/x';
const OFFLINE = { isConnected: false, isInternetReachable: false };
const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clients: SmartRetryClient[] = [];

function makeClient(options: SmartRetryClientOptions = {}): SmartRetryClient {
  const client = createSmartRetry({
    asyncStorage: createMemoryAsyncStorage(),
    networkMonitor: new FakeNetworkMonitor(),
    appState: null,
    ...options,
  });
  clients.push(client);
  return client;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.destroy());
});

function sentHeaders(mock: jest.Mock, call: number): Record<string, string> {
  return (mock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

describe('baseURL', () => {
  it('resolves relative URLs, stores them resolved, and leaves absolute URLs alone', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const client = makeClient();
    client.configure({ baseURL: 'https://api.example.com/v1/' });
    await client.initialize();

    await client.request({ url: '/users', method: 'GET' });
    await client.request({ url: 'https://other.example.com/a', method: 'GET' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/users');
    expect(fetchMock.mock.calls[1][0]).toBe('https://other.example.com/a');
  });
});

describe('beforeRequest', () => {
  it('supplies a fresh token on replay, so tokens need not be stored', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const client = makeClient({ networkMonitor: monitor });
    let token = 'old';
    client.configure({
      beforeRequest: (request) => ({
        ...request,
        headers: { ...request.headers, Authorization: `Bearer ${token}` },
      }),
    });
    await client.initialize();
    await client.queue({ url: URL, method: 'POST' });
    const [stored] = await client.getQueue();
    expect(stored.headers).toBeUndefined();

    token = 'new';
    monitor.goOnline();
    await wait();

    expect(sentHeaders(fetchMock, 0).Authorization).toBe('Bearer new');
  });
});

describe('onUnauthorized', () => {
  it('retries once after a successful refresh', async () => {
    const fetchMock = installMockFetch([
      { type: 'response', status: 401 },
      { type: 'response', status: 200, body: { ok: true } },
    ]);
    const onUnauthorized = jest.fn(async () => true);
    const client = makeClient();
    client.configure({ onUnauthorized });
    await client.initialize();

    const result = await client.request({ url: URL, method: 'POST' });

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('keeps a replayed request alive through a token refresh', async () => {
    installMockFetch([
      { type: 'response', status: 401 },
      { type: 'response', status: 200, body: {} },
    ]);
    const client = makeClient();
    client.configure({ onUnauthorized: () => true });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait();

    expect(await client.getQueueCount()).toBe(0);
  });

  it('shares one refresh between concurrent 401s', async () => {
    installMockFetch([
      { type: 'response', status: 401 },
      { type: 'response', status: 401 },
      { type: 'response', status: 200, body: {} },
    ]);
    const onUnauthorized = jest.fn(async () => {
      await wait(5);
      return true;
    });
    const client = makeClient();
    client.configure({ onUnauthorized });
    await client.initialize();

    await Promise.all([
      client.request({ url: URL, method: 'GET' }),
      client.request({ url: URL, method: 'GET' }),
    ]);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('fails normally when the refresh is declined or throws', async () => {
    installMockFetch([{ type: 'response', status: 401 }]);
    const client = makeClient();
    client.configure({
      onUnauthorized: () => {
        throw new Error('no session');
      },
    });
    await client.initialize();

    const result = await client.request({ url: URL, method: 'GET' });

    expect(result).toMatchObject({ status: 'failed', error: { status: 401 } });
  });
});

describe('failed response bodies', () => {
  it('exposes the error body in the result', async () => {
    installMockFetch([{ type: 'response', status: 422, body: { email: 'invalid' } }]);
    const client = makeClient();
    await client.initialize();

    const result = await client.request({ url: URL, method: 'POST' });

    expect(result).toMatchObject({ status: 'failed', error: { status: 422, data: { email: 'invalid' } } });
  });

  it('gives the body to onFailure but keeps it out of storage', async () => {
    installMockFetch([{ type: 'response', status: 422, body: { secret: 'x' } }]);
    const onFailure = jest.fn();
    const client = makeClient();
    client.configure({ onFailure });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait();

    expect(onFailure.mock.calls[0][1].data).toEqual({ secret: 'x' });
    const [stored] = await client.getQueue();
    expect(stored.lastError?.data).toBeUndefined();
  });
});

describe('retryFailed()', () => {
  it('puts failed requests back in the queue with a fresh budget', async () => {
    installMockFetch([
      { type: 'response', status: 400 },
      { type: 'response', status: 200, body: {} },
    ]);
    const client = makeClient();
    await client.initialize();
    await client.queue({ url: URL, method: 'POST' });
    await wait();
    expect(await client.getQueueCount('failed')).toBe(1);

    expect(await client.retryFailed()).toBe(1);
    await wait();

    expect(await client.getQueueCount()).toBe(0);
  });

  it('can target a single request', async () => {
    installMockFetch([{ type: 'response', status: 400 }]);
    const client = makeClient();
    await client.initialize();
    await client.queue({ url: URL, method: 'POST' });
    await wait();

    expect(await client.retryFailed('unknown-id')).toBe(0);
  });
});

describe('maxQueueSize', () => {
  it('refuses new requests when full of live ones', async () => {
    const client = makeClient({ networkMonitor: new FakeNetworkMonitor(OFFLINE) });
    client.configure({ maxQueueSize: 1 });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    const result = await client.queue({ url: URL, method: 'POST' });

    expect(result).toMatchObject({ status: 'failed', error: { reason: 'QUEUE_FULL' } });
    expect(await client.getQueueCount()).toBe(1);
  });

  it('evicts the oldest failed request to make room', async () => {
    installMockFetch([{ type: 'response', status: 400 }]);
    const monitor = new FakeNetworkMonitor();
    const client = makeClient({ networkMonitor: monitor });
    client.configure({ maxQueueSize: 1 });
    await client.initialize();
    await client.queue({ url: `${URL}/old`, method: 'POST' });
    await wait();

    monitor.goOffline();
    const result = await client.queue({ url: `${URL}/new`, method: 'POST' });

    expect(result.status).toBe('queued');
    expect((await client.getQueue()).map((r) => r.url)).toEqual([`${URL}/new`]);
  });
});

describe('maxRequestAge', () => {
  it('fails expired requests instead of sending them', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const onFailure = jest.fn();
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const client = makeClient({ networkMonitor: monitor });
    client.configure({ maxRequestAge: 5, onFailure });
    await client.initialize();
    await client.queue({ url: URL, method: 'POST' });
    await wait(15);

    monitor.goOnline();
    await wait();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFailure.mock.calls[0][1].reason).toBe('EXPIRED');
  });
});

describe('app lifecycle', () => {
  class FakeAppState implements AppStateLike {
    currentState = 'active';
    private listener: ((state: string) => void) | null = null;
    removed = false;

    addEventListener(_type: 'change', listener: (state: string) => void) {
      this.listener = listener;
      return {
        remove: () => {
          this.removed = true;
        },
      };
    }

    change(state: string): void {
      this.currentState = state;
      this.listener?.(state);
    }
  }

  it('holds the queue while backgrounded and syncs on return', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const appState = new FakeAppState();
    const client = makeClient({ appState });
    await client.initialize();

    appState.change('background');
    await client.queue({ url: URL, method: 'POST' });
    await wait();
    expect(fetchMock).not.toHaveBeenCalled();

    appState.change('active');
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects a launch that starts in the background', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const appState = new FakeAppState();
    appState.currentState = 'background';
    const client = makeClient({ appState });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps syncing in the background when pausing is off, and resumes if it was turned off while paused', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const appState = new FakeAppState();
    const client = makeClient({ appState });
    await client.initialize();
    appState.change('background');
    await client.queue({ url: URL, method: 'POST' });

    client.configure({ pauseWhenBackgrounded: false });
    appState.change('active');
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes states and unsubscribes on destroy', () => {
    const appState = new FakeAppState();
    const manager = new AppLifecycleManager(appState);
    const seen: string[] = [];
    manager.subscribe((state) => seen.push(state));
    manager.start();
    manager.start();

    appState.change('inactive');
    appState.change('extension');
    manager.destroy();

    expect(seen).toEqual(['inactive', 'unknown']);
    expect(manager.getCurrentState()).toBe('unknown');
    expect(appState.removed).toBe(true);
  });
});
