import { createSmartRetry } from '../src/core/SmartRetry';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';
import { installMockFetch } from './helpers/mockFetch';

function flushAsync(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SmartRetry (integration)', () => {
  describe('Scenario 1: internet on, request succeeds', () => {
    it('returns a success result and leaves the queue empty', async () => {
      installMockFetch([{ type: 'response', status: 200, body: { ok: true } }]);
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: new FakeNetworkMonitor(),
        appState: null,
      });
      await client.initialize();

      const result = await client.request({ url: 'https://api.example.com/attendance', method: 'POST' });

      expect(result.status).toBe('success');
      expect(result.queued).toBe(false);
      expect(await client.getQueueCount()).toBe(0);
      client.destroy();
    });
  });

  describe('Scenario 2: internet off, queue:true', () => {
    it('returns a queued result and the queue count becomes 1', async () => {
      installMockFetch([{ type: 'network-error' }]);
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
        appState: null,
      });
      await client.initialize();

      const result = await client.request({
        url: 'https://api.example.com/attendance',
        method: 'POST',
        data: { employeeId: 123 },
        queue: true,
      });

      expect(result.status).toBe('queued');
      expect(result.queued).toBe(true);
      if (result.status === 'queued') {
        expect(result.queueId).toMatch(/^req_/);
      }
      expect(await client.getQueueCount()).toBe(1);
      client.destroy();
    });
  });

  describe('Scenario 3: offline, app restart, internet returns', () => {
    it('restores the persisted request and syncs it once online', async () => {
      const disk = new Map<string, string>();

      installMockFetch([{ type: 'network-error' }]);
      const sessionOne = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(disk),
        networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
        appState: null,
      });
      await sessionOne.initialize();

      const queued = await sessionOne.request({
        url: 'https://api.example.com/attendance',
        method: 'POST',
        data: { employeeId: 123 },
        queue: true,
      });
      expect(queued.status).toBe('queued');

      // "App closes": tear down the first session entirely.
      sessionOne.destroy();

      // "App reopens": a fresh client over the same disk, offline is still true at first.
      const monitorTwo = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
      const sessionTwo = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(disk),
        networkMonitor: monitorTwo,
        appState: null,
      });
      await sessionTwo.initialize();

      expect(await sessionTwo.getQueueCount()).toBe(1);

      installMockFetch([{ type: 'response', status: 200, body: { ok: true } }]);
      monitorTwo.goOnline();
      await flushAsync();

      expect(await sessionTwo.getQueueCount()).toBe(0);
      sessionTwo.destroy();
    });
  });

  describe('Scenario 4: A, B, C all succeed', () => {
    it('empties the queue', async () => {
      const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: monitor,
        appState: null,
      });
      await client.initialize();

      installMockFetch([{ type: 'network-error' }]);
      await client.request({ url: 'https://api.example.com/a', method: 'POST', queue: true });
      await client.request({ url: 'https://api.example.com/b', method: 'POST', queue: true });
      await client.request({ url: 'https://api.example.com/c', method: 'POST', queue: true });
      expect(await client.getQueueCount()).toBe(3);

      installMockFetch([{ type: 'response', status: 200, body: {} }]);
      monitor.goOnline();
      await flushAsync();

      expect(await client.getQueueCount()).toBe(0);
      client.destroy();
    });
  });

  describe('Scenario 5: A succeeds, B network failure, C never attempted', () => {
    it('deletes A, retains B and C', async () => {
      const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: monitor,
        appState: null,
      });
      await client.initialize();

      installMockFetch([{ type: 'network-error' }]);
      const a = await client.request({ url: 'https://api.example.com/a', method: 'POST', queue: true });
      const b = await client.request({ url: 'https://api.example.com/b', method: 'POST', queue: true });
      const c = await client.request({ url: 'https://api.example.com/c', method: 'POST', queue: true });

      const aId = a.status === 'queued' ? a.queueId : '';
      const bId = b.status === 'queued' ? b.queueId : '';
      const cId = c.status === 'queued' ? c.queueId : '';

      installMockFetch([
        { type: 'response', status: 200, body: {} }, // A succeeds
        { type: 'network-error' }, // B fails
      ]);
      monitor.goOnline();
      await flushAsync();

      const remaining = await client.getQueue();
      const remainingIds = remaining.map((r) => r.id);
      expect(remainingIds).not.toContain(aId);
      expect(remainingIds).toContain(bId);
      expect(remainingIds).toContain(cId);
      client.destroy();
    });
  });

  describe('Scenario 6: permanent client error', () => {
    it('does not create a queued entry and does not retry indefinitely', async () => {
      installMockFetch([{ type: 'response', status: 400, body: { message: 'invalid' } }]);
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: new FakeNetworkMonitor(),
        appState: null,
      });
      await client.initialize();

      const result = await client.request({
        url: 'https://api.example.com/attendance',
        method: 'POST',
        queue: true,
      });

      expect(result.status).toBe('failed');
      expect(await client.getQueueCount()).toBe(0);
      client.destroy();
    });
  });

  describe('Scenario 7: concurrent processQueue() calls', () => {
    it('runs only one processor', async () => {
      const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
      const client = createSmartRetry({
        asyncStorage: createMemoryAsyncStorage(),
        networkMonitor: monitor,
        appState: null,
      });
      await client.initialize();

      installMockFetch([{ type: 'network-error' }]);
      await client.request({ url: 'https://api.example.com/a', method: 'POST', queue: true });

      monitor.goOnline();
      const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
      await Promise.all([client.processQueue(), client.processQueue(), client.processQueue()]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      client.destroy();
    });
  });

  it('does not queue a plain request without queue:true, returning failed on error', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    await client.initialize();

    const result = await client.request({ url: 'https://api.example.com/users', method: 'GET' });

    expect(result.status).toBe('failed');
    expect(await client.getQueueCount()).toBe(0);
    client.destroy();
  });

  it('suppresses duplicate requests sharing a uniqueKey', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    await client.initialize();

    const first = await client.request({
      url: 'https://api.example.com/attendance',
      method: 'POST',
      data: { employeeId: 123 },
      queue: true,
      uniqueKey: 'attendance-123-2026-09-17',
    });
    const second = await client.request({
      url: 'https://api.example.com/attendance',
      method: 'POST',
      data: { employeeId: 123 },
      queue: true,
      uniqueKey: 'attendance-123-2026-09-17',
    });

    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    if (first.status === 'queued' && second.status === 'queued') {
      expect(second.queueId).toBe(first.queueId);
    }
    expect(await client.getQueueCount()).toBe(1);
    client.destroy();
  });

  it('fires configured lifecycle events for a queued-then-synced request', async () => {
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: monitor,
      appState: null,
    });

    const onQueued = jest.fn();
    const onSuccess = jest.fn();
    const onQueueStart = jest.fn();
    const onQueueComplete = jest.fn();
    const onNetworkChange = jest.fn();
    client.configure({ onQueued, onSuccess, onQueueStart, onQueueComplete, onNetworkChange });
    await client.initialize();

    installMockFetch([{ type: 'network-error' }]);
    await client.request({ url: 'https://api.example.com/x', method: 'POST', queue: true });
    expect(onQueued).toHaveBeenCalledTimes(1);

    installMockFetch([{ type: 'response', status: 200, body: { ok: true } }]);
    monitor.goOnline();
    await flushAsync();

    expect(onNetworkChange).toHaveBeenCalled();
    expect(onQueueStart).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onQueueComplete).toHaveBeenCalledWith({ processed: 1, succeeded: 1, failed: 0 });
    client.destroy();
  });

  it('reports isOnline() based on the current network state', async () => {
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: monitor,
      appState: null,
    });
    await client.initialize();

    expect(await client.isOnline()).toBe(false);
    monitor.goOnline();
    expect(await client.isOnline()).toBe(true);
    client.destroy();
  });

  it('clearQueue() removes all persisted requests', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    await client.initialize();

    await client.request({ url: 'https://api.example.com/a', method: 'POST', queue: true });
    await client.request({ url: 'https://api.example.com/b', method: 'POST', queue: true });
    expect(await client.getQueueCount()).toBe(2);

    await client.clearQueue();
    expect(await client.getQueueCount()).toBe(0);
    client.destroy();
  });

  it('remove(id) deletes a single queued request', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    await client.initialize();

    const result = await client.request({ url: 'https://api.example.com/a', method: 'POST', queue: true });
    const id = result.status === 'queued' ? result.queueId : '';

    await client.remove(id);
    expect(await client.getQueueCount()).toBe(0);
    client.destroy();
  });

  it('SmartRetry.queue() persists immediately without attempting a live call first', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    await client.initialize();

    const result = await client.queue({ url: 'https://api.example.com/a', method: 'POST' });

    expect(result.status).toBe('queued');
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
  });

  it('never logs request payload data even when debug is enabled', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    installMockFetch([{ type: 'network-error' }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }),
      appState: null,
    });
    client.configure({ debug: true });
    await client.initialize();

    await client.request({
      url: 'https://api.example.com/login',
      method: 'POST',
      data: { password: 'super-secret-value' },
      queue: true,
    });

    const loggedText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).not.toContain('super-secret-value');

    logSpy.mockRestore();
    client.destroy();
  });
});
