import { FetchAdapter } from '../src/adapters/FetchAdapter';
import { NetworkManager } from '../src/network/NetworkManager';
import { QueueEventEmitter } from '../src/queue/QueueEvents';
import { QueueManager } from '../src/queue/QueueManager';
import { DEFAULT_RETRY_POLICY } from '../src/retry/RetryPolicy';
import { AsyncStorageStorage } from '../src/storage/AsyncStorageStorage';
import { Logger } from '../src/utils/logger';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';
import { installMockFetch } from './helpers/mockFetch';

function makeManager(monitor: FakeNetworkMonitor) {
  const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
  const networkManager = new NetworkManager(monitor);
  const events = new QueueEventEmitter();
  const manager = new QueueManager({
    storage,
    networkManager,
    fetchAdapter: new FetchAdapter(),
    events,
    logger: new Logger(false),
    getPolicy: () => DEFAULT_RETRY_POLICY,
    getDefaultTimeout: () => 1000,
    preventDuplicates: () => true,
    getTransformBeforePersist: () => undefined,
    staleProcessingThresholdMs: () => 60000,
  });
  return { manager, storage, events, networkManager };
}

describe('QueueManager', () => {
  it('suppresses a duplicate enqueue for the same uniqueKey while one is pending', async () => {
    const { manager } = makeManager(new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }));

    const first = await manager.enqueue({
      url: '/attendance',
      method: 'POST',
      data: { employeeId: 123 },
      uniqueKey: 'attendance-123-2026-09-17',
    });
    const second = await manager.enqueue({
      url: '/attendance',
      method: 'POST',
      data: { employeeId: 123 },
      uniqueKey: 'attendance-123-2026-09-17',
    });

    expect(second.id).toBe(first.id);
    expect(await manager.getCount()).toBe(1);
  });

  it('allows a new request once the prior one with the same uniqueKey has failed permanently', async () => {
    const { manager, storage } = makeManager(new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false }));

    const first = await manager.enqueue({ url: '/x', method: 'POST', uniqueKey: 'k1' });
    await storage.update(first.id, { status: 'failed' });

    const second = await manager.enqueue({ url: '/x', method: 'POST', uniqueKey: 'k1' });
    expect(second.id).not.toBe(first.id);
  });

  it('does not suppress duplicates when preventDuplicates is disabled', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const networkManager = new NetworkManager(monitor);
    const manager = new QueueManager({
      storage,
      networkManager,
      fetchAdapter: new FetchAdapter(),
      events: new QueueEventEmitter(),
      logger: new Logger(false),
      getPolicy: () => DEFAULT_RETRY_POLICY,
      getDefaultTimeout: () => 1000,
      preventDuplicates: () => false,
      getTransformBeforePersist: () => undefined,
      staleProcessingThresholdMs: () => 60000,
    });

    await manager.enqueue({ url: '/x', method: 'POST', uniqueKey: 'k1' });
    await manager.enqueue({ url: '/x', method: 'POST', uniqueKey: 'k1' });

    expect(await manager.getCount()).toBe(2);
  });

  it('automatically processes the queue when the network transitions from offline to online', async () => {
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const { manager, storage } = makeManager(monitor);
    installMockFetch([{ type: 'response', status: 200, body: { ok: true } }]);

    await manager.initialize();
    await manager.enqueue({ url: 'https://api.example.com/x', method: 'POST' });
    expect(await manager.getCount()).toBe(1);

    monitor.goOnline();
    await flushAsync();

    expect(await manager.getCount()).toBe(0);
    manager.destroy();
  });

  it('applies transformBeforePersist before writing to storage', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const networkManager = new NetworkManager(monitor);
    const manager = new QueueManager({
      storage,
      networkManager,
      fetchAdapter: new FetchAdapter(),
      events: new QueueEventEmitter(),
      logger: new Logger(false),
      getPolicy: () => DEFAULT_RETRY_POLICY,
      getDefaultTimeout: () => 1000,
      preventDuplicates: () => true,
      getTransformBeforePersist: () => (request) => ({ ...request, data: { redacted: true } }),
      staleProcessingThresholdMs: () => 60000,
    });

    const item = await manager.enqueue({ url: '/x', method: 'POST', data: { password: 'secret' } });
    expect(item.data).toEqual({ redacted: true });
  });
});

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
