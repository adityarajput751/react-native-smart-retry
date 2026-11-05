import { NetworkManager } from '../src/network/NetworkManager';
import { RetryError } from '../src/errors/RetryError';
import { QueueEventEmitter } from '../src/queue/QueueEvents';
import { QueueProcessor, type QueueRequestExecutor } from '../src/queue/QueueProcessor';
import { AsyncStorageStorage } from '../src/storage/AsyncStorageStorage';
import type { QueueStorage } from '../src/storage/QueueStorage';
import { DEFAULT_RETRY_POLICY } from '../src/retry/RetryPolicy';
import type { QueuedRequest } from '../src/types';
import { Logger } from '../src/utils/logger';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';

function makeRequest(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  const now = Date.now();
  return {
    id: overrides.id ?? `req_${Math.random().toString(36).slice(2)}`,
    url: 'https://api.example.com/attendance',
    method: 'POST',
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    status: 'pending',
    ...overrides,
  };
}

interface TestSetup {
  processor: QueueProcessor;
  storage: QueueStorage;
  networkManager: NetworkManager;
  monitor: FakeNetworkMonitor;
  events: QueueEventEmitter;
  executeRequest: jest.MockedFunction<QueueRequestExecutor>;
}

function setup(): TestSetup {
  const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
  const monitor = new FakeNetworkMonitor();
  const networkManager = new NetworkManager(monitor);
  networkManager.start();
  const events = new QueueEventEmitter();
  const executeRequest = jest.fn<ReturnType<QueueRequestExecutor>, Parameters<QueueRequestExecutor>>();

  const processor = new QueueProcessor({
    storage,
    networkManager,
    executeRequest,
    events,
    getPolicy: () => ({ ...DEFAULT_RETRY_POLICY, baseDelay: 5, maxDelay: 20 }),
    logger: new Logger(false),
  });

  activeProcessors.push(processor);
  return { processor, storage, networkManager, monitor, events, executeRequest };
}

const activeProcessors: QueueProcessor[] = [];

afterEach(() => {
  activeProcessors.splice(0).forEach((processor) => processor.destroy());
});

describe('QueueProcessor', () => {
  it('processes requests strictly in FIFO order (by creation time)', async () => {
    const { processor, storage, executeRequest } = setup();
    const order: string[] = [];
    executeRequest.mockImplementation(async (request) => {
      order.push(request.id);
      return { status: 200, data: { ok: true } };
    });

    const a = makeRequest({ id: 'A', createdAt: 1 });
    const b = makeRequest({ id: 'B', createdAt: 2 });
    const c = makeRequest({ id: 'C', createdAt: 3 });
    // Insert out of order to prove sorting, not insertion order, drives FIFO.
    await storage.add(c);
    await storage.add(a);
    await storage.add(b);

    await processor.process();

    expect(order).toEqual(['A', 'B', 'C']);
    expect(await storage.getAll()).toEqual([]);
  });

  it('deletes a request only after it succeeds, and stops on the first network failure (A,B succeed; C network error; D retained)', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockImplementation(async (request) => {
      if (request.id === 'C') {
        throw new RetryError({ message: 'offline', reason: 'NETWORK_ERROR', isNetworkError: true });
      }
      return { status: 200, data: {} };
    });

    await storage.add(makeRequest({ id: 'A', createdAt: 1 }));
    await storage.add(makeRequest({ id: 'B', createdAt: 2 }));
    await storage.add(makeRequest({ id: 'C', createdAt: 3 }));
    await storage.add(makeRequest({ id: 'D', createdAt: 4 }));

    await processor.process();

    const remaining = await storage.getAll();
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual(['C', 'D']);

    const c = remaining.find((r) => r.id === 'C')!;
    expect(c.status).toBe('pending');
    // D was never attempted — order preserved, no processing out of turn.
    expect(executeRequest).toHaveBeenCalledTimes(3);
  });

  it('retains B when A succeeds and B hits a network failure', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockImplementation(async (request) => {
      if (request.id === 'B') {
        throw new RetryError({ message: 'offline', reason: 'NETWORK_ERROR', isNetworkError: true });
      }
      return { status: 200, data: {} };
    });

    await storage.add(makeRequest({ id: 'A', createdAt: 1 }));
    await storage.add(makeRequest({ id: 'B', createdAt: 2 }));

    await processor.process();

    expect(await storage.get('A')).toBeNull();
    const b = await storage.get('B');
    expect(b?.status).toBe('pending');
  });

  it('marks a permanent client error as failed and continues to the next request', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockImplementation(async (request) => {
      if (request.id === 'A') {
        throw new RetryError({ message: 'bad request', reason: 'CLIENT_ERROR', status: 400 });
      }
      return { status: 200, data: {} };
    });

    await storage.add(makeRequest({ id: 'A', createdAt: 1 }));
    await storage.add(makeRequest({ id: 'B', createdAt: 2 }));

    await processor.process();

    const a = await storage.get('A');
    expect(a?.status).toBe('failed');
    expect(await storage.get('B')).toBeNull(); // B still processed and succeeded
  });

  it('does not retry a permanent failure indefinitely (single failed record, no retryCount growth)', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockRejectedValue(new RetryError({ message: 'bad', reason: 'CLIENT_ERROR', status: 422 }));
    await storage.add(makeRequest({ id: 'A' }));

    await processor.process();
    await processor.process();
    await processor.process();

    expect(executeRequest).toHaveBeenCalledTimes(1); // second/third process() calls find nothing pending
    const a = await storage.get('A');
    expect(a?.status).toBe('failed');
  });

  it('applies the retry policy for a retryable server error, keeping the request pending with an incremented retryCount', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockRejectedValue(
      new RetryError({ message: 'server', reason: 'SERVER_ERROR', status: 500 })
    );
    await storage.add(makeRequest({ id: 'A', maxRetries: 5 }));

    await processor.process();

    const a = await storage.get('A');
    expect(a?.status).toBe('pending');
    expect(a?.retryCount).toBe(1);
    expect(a?.nextAttemptAt).toBeGreaterThan(Date.now() - 1);

    processor.destroy();
  });

  it('marks a request failed once its retry budget is exhausted', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockRejectedValue(
      new RetryError({ message: 'server', reason: 'SERVER_ERROR', status: 500 })
    );
    await storage.add(makeRequest({ id: 'A', maxRetries: 0 }));

    await processor.process();

    const a = await storage.get('A');
    expect(a?.status).toBe('failed');
    processor.destroy();
  });

  it('recovers a request interrupted by a crash immediately, in FIFO position', async () => {
    const { processor, storage, executeRequest } = setup();
    const order: string[] = [];
    executeRequest.mockImplementation(async (request) => {
      order.push(request.id);
      return { status: 200, data: {} };
    });

    await storage.add(makeRequest({ id: 'A', status: 'processing', updatedAt: Date.now(), createdAt: 1 }));
    await storage.add(makeRequest({ id: 'B', createdAt: 2 }));

    await processor.process();

    expect(order).toEqual(['A', 'B']);
    expect(await storage.getAll()).toHaveLength(0);
  });

  it('never runs two processing passes concurrently', async () => {
    const { processor, storage, executeRequest } = setup();
    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;

    executeRequest.mockImplementation(async () => {
      concurrentCalls++;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentCalls--;
      return { status: 200, data: {} };
    });

    await storage.add(makeRequest({ id: 'A', createdAt: 1 }));
    await storage.add(makeRequest({ id: 'B', createdAt: 2 }));
    await storage.add(makeRequest({ id: 'C', createdAt: 3 }));

    await Promise.all([processor.process(), processor.process(), processor.process()]);

    expect(maxConcurrentCalls).toBe(1);
    expect(executeRequest).toHaveBeenCalledTimes(3); // each of A, B, C processed exactly once
  });

  it('does not process the queue while offline', async () => {
    const { processor, storage, monitor, executeRequest } = setup();
    monitor.goOffline();
    await storage.add(makeRequest({ id: 'A' }));

    await processor.process();

    expect(executeRequest).not.toHaveBeenCalled();
  });

  it('pauses and resumes processing (app backgrounded/foregrounded)', async () => {
    const { processor, storage, executeRequest } = setup();
    executeRequest.mockResolvedValue({ status: 200, data: {} });
    await storage.add(makeRequest({ id: 'A' }));

    processor.pause();
    await processor.process();
    expect(executeRequest).not.toHaveBeenCalled();

    processor.resume();
    await processor.process();
    expect(executeRequest).toHaveBeenCalledTimes(1);
  });
});
