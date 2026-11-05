import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createSmartRetry, type SmartRetryClient } from '../src/core/SmartRetry';
import { useSmartRetryQueue, type SmartRetryQueueState } from '../src/hooks/useSmartRetryQueue';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';
import { createMemoryAsyncStorage } from './helpers/memoryAsyncStorage';
import { installMockFetch } from './helpers/mockFetch';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL = 'https://api.example.com/x';
const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mountHook(client: SmartRetryClient) {
  const state: { current: SmartRetryQueueState | null } = { current: null };
  function Probe(): null {
    state.current = useSmartRetryQueue(client);
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(Probe));
    await wait();
  });
  return { state, unmount: () => renderer?.unmount() };
}

describe('useSmartRetryQueue', () => {
  it('tracks the queue and connectivity live', async () => {
    const fetchMock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const monitor = new FakeNetworkMonitor({ isConnected: false, isInternetReachable: false });
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: monitor,
      appState: null,
    });
    const { state, unmount } = await mountHook(client);
    expect(state.current).toMatchObject({ pendingCount: 0, isOnline: false, isSyncing: false });

    await act(async () => {
      await client.queue({ url: URL, method: 'POST' });
      await wait();
    });
    expect(state.current?.pendingCount).toBe(1);

    await act(async () => {
      monitor.goOnline();
      await wait();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({
      pendingCount: 0,
      failedCount: 0,
      isOnline: true,
      isSyncing: false,
    });

    unmount();
    client.destroy();
  });

  it('reports failed requests separately', async () => {
    installMockFetch([{ type: 'response', status: 400 }]);
    const client = createSmartRetry({
      asyncStorage: createMemoryAsyncStorage(),
      networkMonitor: new FakeNetworkMonitor(),
      appState: null,
    });
    const { state, unmount } = await mountHook(client);

    await act(async () => {
      await client.queue({ url: URL, method: 'POST' });
      await wait();
    });

    expect(state.current).toMatchObject({ pendingCount: 0, failedCount: 1 });
    unmount();
    client.destroy();
  });
});
