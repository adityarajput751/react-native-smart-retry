import { AsyncStorageStorage } from '../src/storage/AsyncStorageStorage';
import type { QueuedRequest } from '../src/types';
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

describe('AsyncStorageStorage', () => {
  it('adds and retrieves a request', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const request = makeRequest();
    await storage.add(request);

    expect(await storage.get(request.id)).toEqual(request);
    expect(await storage.getAll()).toEqual([request]);
  });

  it('updates a request by merging fields', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const request = makeRequest();
    await storage.add(request);

    await storage.update(request.id, { status: 'failed', retryCount: 2 });
    const updated = await storage.get(request.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.retryCount).toBe(2);
    expect(updated?.url).toBe(request.url);
  });

  it('is a no-op when updating a non-existent id', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    await expect(storage.update('missing', { status: 'failed' })).resolves.toBeUndefined();
  });

  it('removes a request from both the item store and the index', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const a = makeRequest();
    const b = makeRequest();
    await storage.add(a);
    await storage.add(b);

    await storage.remove(a.id);

    expect(await storage.get(a.id)).toBeNull();
    expect(await storage.getAll()).toEqual([b]);
  });

  it('clears all requests', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    await storage.add(makeRequest());
    await storage.add(makeRequest());

    await storage.clear();

    expect(await storage.getAll()).toEqual([]);
  });

  it('persists across a new storage instance backed by the same disk (simulated app restart)', async () => {
    const disk = new Map<string, string>();
    const sessionOne = new AsyncStorageStorage(createMemoryAsyncStorage(disk));
    const request = makeRequest();
    await sessionOne.add(request);

    // "app restart": a brand new instance over the same underlying disk.
    const sessionTwo = new AsyncStorageStorage(createMemoryAsyncStorage(disk));
    expect(await sessionTwo.getAll()).toEqual([request]);
  });

  it('skips a malformed record instead of discarding the whole queue', async () => {
    const disk = new Map<string, string>();
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage(disk));
    const good = makeRequest();
    await storage.add(good);

    // Manually corrupt a second index entry that was never written properly.
    const index = JSON.parse(disk.get('@react-native-smart-retry/queue-index')!) as string[];
    index.push('corrupted-id');
    disk.set('@react-native-smart-retry/queue-index', JSON.stringify(index));
    disk.set('@react-native-smart-retry/queue-item/corrupted-id', '{not valid json');

    const all = await storage.getAll();
    expect(all).toEqual([good]);
  });

  it('does not add duplicate ids to the index when adding the same request twice', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const request = makeRequest();
    await storage.add(request);
    await storage.add(request);

    expect(await storage.getAll()).toHaveLength(1);
  });

  it('serializes concurrent writes so the index is never corrupted by a race', async () => {
    const storage = new AsyncStorageStorage(createMemoryAsyncStorage());
    const requests = Array.from({ length: 20 }, () => makeRequest());

    await Promise.all(requests.map((request) => storage.add(request)));

    const all = await storage.getAll();
    expect(all).toHaveLength(20);
    const ids = new Set(all.map((r) => r.id));
    expect(ids.size).toBe(20);
  });
});
