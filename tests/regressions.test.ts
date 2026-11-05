import { AsyncStorageStorage, type AsyncStorageLike } from '../src/storage/AsyncStorageStorage';
import {
  createSmartRetry,
  type SmartRetryClient,
  type SmartRetryClientOptions,
} from '../src/core/SmartRetry';
import { classifyThrownError } from '../src/errors/ErrorClassifier';
import type { QueuedRequest } from '../src/types';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';
import { installMockFetch } from './helpers/mockFetch';

const URL = 'https://api.example.com/x';
const OFFLINE = { isConnected: false, isInternetReachable: false };

const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function item(id: string, overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  const now = Date.now();
  return {
    id,
    url: URL,
    method: 'POST',
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    status: 'pending',
    ...overrides,
  };
}

/** A fetch whose responses stay pending until `release()`. */
function installHeldFetch(): { mock: jest.Mock; release: () => void } {
  const waiting: Array<() => void> = [];
  const mock = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        waiting.push(() =>
          resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
        );
      })
  );
  (global as unknown as { fetch: unknown }).fetch = mock;
  return { mock, release: () => waiting.splice(0).forEach((resolve) => resolve()) };
}

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

describe('storage safety', () => {
  it('does not lose a request when getAll() overlaps add()', async () => {
    const disk = new Map<string, string>();
    const base = createMemoryAsyncStorage(disk);
    const slow: AsyncStorageLike = {
      ...base,
      setItem: async (key, value) => {
        await wait(10);
        await base.setItem(key, value);
      },
    };
    const storage = new AsyncStorageStorage(slow);

    const adding = storage.add(item('a'));
    await wait(14);
    await storage.getAll();
    await adding;

    expect((await new AsyncStorageStorage(base).getAll()).map((r) => r.id)).toEqual(['a']);
  });

  it('rebuilds a corrupted index from the stored items', async () => {
    const disk = new Map<string, string>();
    const base = createMemoryAsyncStorage(disk);
    const storage = new AsyncStorageStorage({
      ...base,
      getAllKeys: async () => [...disk.keys()],
    });
    await storage.add(item('a'));
    await storage.add(item('b'));

    disk.set('@react-native-smart-retry/queue-index', '{broken');

    expect((await storage.getAll()).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('lifecycle of the client', () => {
  it('keeps syncing after destroy() then initialize(), as under React StrictMode', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const client = makeClient({ networkMonitor: monitor });

    await client.initialize();
    client.destroy();
    await client.initialize();
    await client.queue({ url: URL, method: 'POST' });

    monitor.goOnline();
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await client.getQueueCount()).toBe(0);
  });

  it('does not make API calls wait for the backlog to drain', async () => {
    const disk = new Map<string, string>();
    await new AsyncStorageStorage(createMemoryAsyncStorage(disk)).add(item('a'));
    const { release } = installHeldFetch();
    const client = makeClient({ asyncStorage: createMemoryAsyncStorage(disk) });

    const outcome = await Promise.race([
      client.getQueueCount().then(() => 'returned'),
      wait(100).then(() => 'blocked'),
    ]);

    expect(outcome).toBe('returned');
    await wait();
    release();
    await wait();
  });

  it('survives a transient storage error during startup', async () => {
    const base = createMemoryAsyncStorage();
    let reads = 0;
    const flaky: AsyncStorageLike = {
      ...base,
      getItem: async (key) => {
        if (reads++ === 0) {
          throw new Error('disk busy');
        }
        return base.getItem(key);
      },
    };
    installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const client = makeClient({ asyncStorage: flaky });

    await client.initialize();
    await wait();

    const result = await client.request({ url: URL, method: 'GET' });
    expect(result.status).toBe('success');
  });

  it('can be imported without AsyncStorage when a custom storage is used', () => {
    jest.isolateModules(() => {
      jest.doMock('@react-native-async-storage/async-storage', () => {
        throw new Error('not installed');
      });
      expect(() => require('../src/index')).not.toThrow();
      jest.dontMock('@react-native-async-storage/async-storage');
    });
  });

  it('applies debug logging to storage warnings', async () => {
    const disk = new Map<string, string>();
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage(disk));
    await storage.add(item('bad'));
    disk.set('@react-native-smart-retry/queue-item/bad', '{broken');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = makeClient({ asyncStorage: createMemoryAsyncStorage(disk) });
    client.configure({ debug: true });

    await client.getQueue();

    expect(warn).toHaveBeenCalled();
    client.configure({ debug: false });
    jest.restoreAllMocks();
  });
});

describe('queue processing', () => {
  it('picks up a request added while a run is in progress', async () => {
    const { mock, release } = installHeldFetch();
    const client = makeClient();
    await client.initialize();

    await client.queue({ url: `${URL}/a`, method: 'POST' });
    await wait();
    await client.queue({ url: `${URL}/b`, method: 'POST' });
    await wait();
    release();
    await wait();
    release();
    await wait();

    expect(mock).toHaveBeenCalledTimes(2);
    expect(await client.getQueueCount()).toBe(0);
  });

  it('sends nothing further after clearQueue() during a run, and aborts the one in flight', async () => {
    const fetchMock = installMockFetch([{ type: 'hang' }]);
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const client = makeClient({ networkMonitor: monitor });
    await client.initialize();
    for (const name of ['a', 'b', 'c']) {
      await client.queue({ url: `${URL}/${name}`, method: 'POST' });
    }

    monitor.goOnline();
    await wait();
    await client.clearQueue();
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(await client.getQueueCount()).toBe(0);
  });

  it('skips a request removed during a run', async () => {
    const { mock, release } = installHeldFetch();
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const client = makeClient({ networkMonitor: monitor });
    await client.initialize();
    await client.queue({ url: `${URL}/a`, method: 'POST' });
    await wait(2);
    const second = await client.queue({ url: `${URL}/b`, method: 'POST' });

    monitor.goOnline();
    await wait();
    if (second.status === 'queued') {
      await client.remove(second.queueId);
    }
    release();
    await wait();

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff after a network error while the device still reports online', async () => {
    const fetchMock = installMockFetch([
      { type: 'network-error' },
      { type: 'response', status: 200, body: {} },
    ]);
    const client = makeClient();
    client.configure({ baseDelay: 5, maxDelay: 10 });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait(80);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await client.getQueueCount()).toBe(0);
  });

  it("does not use up a request's retries on connectivity failures", async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = makeClient();
    client.configure({ baseDelay: 1, maxDelay: 2, retries: 1 });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait(50);

    const [request] = await client.getQueue();
    expect(request.status).not.toBe('failed');
    expect(request.retryCount).toBe(0);
  });

  it('honors Retry-After on the first replay of a request queued by a 429', async () => {
    const fetchMock = installMockFetch([
      { type: 'response', status: 429, headers: { 'Retry-After': '60' } },
      { type: 'response', status: 200, body: {} },
    ]);
    const client = makeClient();
    await client.initialize();

    await client.request({ url: URL, method: 'POST', queue: true });
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request] = await client.getQueue();
    expect(request.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('lets processQueue() override a backoff delay', async () => {
    const fetchMock = installMockFetch([
      { type: 'response', status: 429, headers: { 'Retry-After': '60' } },
      { type: 'response', status: 200, body: {} },
    ]);
    const client = makeClient();
    await client.initialize();
    await client.request({ url: URL, method: 'POST', queue: true });

    await client.processQueue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await client.getQueueCount()).toBe(0);
  });

  it('uses per-request backoff settings on replay', async () => {
    installMockFetch([{ type: 'response', status: 503 }]);
    const client = makeClient();
    client.configure({ baseDelay: 60000, maxDelay: 60000 });
    await client.initialize();
    const delays: number[] = [];
    client.on('retry', (info) => delays.push(info.delay));

    await client.queue({ url: URL, method: 'POST', strategy: 'fixed', baseDelay: 7, maxDelay: 7 });
    await wait();

    expect(delays[0]).toBe(7);
  });

  it('does not report failure when an onSuccess callback throws', async () => {
    installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const onFailure = jest.fn();
    const client = makeClient();
    client.configure({
      onSuccess: () => {
        throw new Error('app bug');
      },
      onFailure,
    });
    await client.initialize();

    await client.queue({ url: URL, method: 'POST' });
    await wait();

    expect(onFailure).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(await client.getQueueCount()).toBe(0);
    jest.restoreAllMocks();
  });
});

describe('request()', () => {
  it('treats a 2xx with an empty JSON body as success and sends it once', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 201 }]);
    const client = makeClient();
    await client.initialize();

    const result = await client.request({ url: URL, method: 'POST', queue: true });
    await wait();

    expect(result).toMatchObject({ status: 'success', response: undefined, httpStatus: 201 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not queue a request the caller cancelled', async () => {
    installMockFetch([{ type: 'hang' }]);
    const client = makeClient({ networkMonitor: new FakeNetworkMonitor(OFFLINE) });
    await client.initialize();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const result = await client.request({ url: URL, method: 'POST', queue: true, signal: controller.signal });

    expect(result).toMatchObject({ status: 'failed', error: { reason: 'ABORTED' } });
    expect(await client.getQueueCount()).toBe(0);
  });

  it('does not queue a request cancelled during a backoff sleep', async () => {
    installMockFetch([{ type: 'response', status: 503 }]);
    const client = makeClient();
    client.configure({ baseDelay: 1000 });
    await client.initialize();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await client.request({ url: URL, method: 'GET', queue: true, signal: controller.signal });

    expect(result).toMatchObject({ status: 'failed', error: { reason: 'ABORTED' } });
    expect(await client.getQueueCount()).toBe(0);
  });

  it('does not queue responses that can never succeed on replay', async () => {
    installMockFetch([{ type: 'response', status: 501 }]);
    const client = makeClient();
    await client.initialize();

    const result = await client.request({ url: URL, method: 'POST', queue: true });

    expect(result.status).toBe('failed');
    expect(await client.getQueueCount()).toBe(0);
  });

  it('applies configure({ timeout }) to immediate requests', async () => {
    installMockFetch([{ type: 'hang' }]);
    const client = makeClient();
    client.configure({ timeout: 10 });
    await client.initialize();

    const result = await client.request({ url: URL, method: 'GET', retries: 0 });

    expect(result).toMatchObject({ status: 'failed', error: { reason: 'TIMEOUT' } });
  });

  it('ignores undefined values passed to configure()', async () => {
    installMockFetch([{ type: 'response', status: 503 }]);
    const client = makeClient();
    client.configure({ retries: undefined, baseDelay: 1 });
    await client.initialize();

    const result = await client.request({ url: URL, method: 'GET' });

    expect(result.status).toBe('failed');
  });

  it("classifies React Native's native timeout as TIMEOUT", () => {
    const error = classifyThrownError(new TypeError('Network request timed out'));
    expect(error.reason).toBe('TIMEOUT');
  });

  it('returns a failed result rather than rejecting when a request cannot be stored', async () => {
    const client = makeClient({ networkMonitor: new FakeNetworkMonitor(OFFLINE) });
    await client.initialize();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(client.queue({ url: URL, method: 'POST', data: circular })).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('refuses to queue a body that would not survive storage', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = makeClient();
    await client.initialize();

    const result = await client.request({ url: URL, method: 'POST', data: new FormData(), queue: true });

    expect(result).toMatchObject({ status: 'failed' });
    expect(await client.getQueueCount()).toBe(0);
  });
});

describe('duplicate protection', () => {
  it('stores one request for concurrent queue() calls with the same uniqueKey', async () => {
    const client = makeClient({ networkMonitor: new FakeNetworkMonitor(OFFLINE) });
    await client.initialize();
    const options = { url: URL, method: 'POST' as const, uniqueKey: 'k' };

    await Promise.all([client.queue(options), client.queue(options)]);

    expect(await client.getQueueCount()).toBe(1);
  });

  it('sends once for concurrent request() calls with the same uniqueKey', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const client = makeClient();
    await client.initialize();
    const options = { url: URL, method: 'POST' as const, uniqueKey: 'k', queue: true };

    await Promise.all([client.request(options), client.request(options)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the live attempt when the same uniqueKey is already queued', async () => {
    const fetchMock = installMockFetch([{ type: 'network-error' }]);
    const client = makeClient({ networkMonitor: new FakeNetworkMonitor(OFFLINE) });
    await client.initialize();
    const options = { url: URL, method: 'POST' as const, uniqueKey: 'k', queue: true };

    const first = await client.request(options);
    const second = await client.request(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
