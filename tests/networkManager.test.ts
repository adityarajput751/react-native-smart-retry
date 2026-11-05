import { createDefaultNetworkMonitor, NetworkManager } from '../src/network/NetworkManager';
import { FakeNetworkMonitor } from './helpers/FakeNetworkMonitor';

const OFFLINE = { isConnected: false, isInternetReachable: false };

describe('NetworkManager', () => {
  it('does not cache connectivity before it is subscribed to changes', async () => {
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const manager = new NetworkManager(monitor);

    expect(await manager.isOnline()).toBe(false);
    monitor.goOnline();

    expect(await manager.isOnline()).toBe(true);
  });

  it('assumes online when the monitor fails', async () => {
    const manager = new NetworkManager({
      fetch: () => Promise.reject(new Error('unavailable')),
      addEventListener: () => () => undefined,
    });

    expect(await manager.isOnline()).toBe(true);
  });

  it('resolves waitUntilOnline() on reconnect', async () => {
    const monitor = new FakeNetworkMonitor(OFFLINE);
    const manager = new NetworkManager(monitor);
    manager.start();

    const waiting = manager.waitUntilOnline();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    monitor.goOnline();

    await expect(waiting).resolves.toBeUndefined();
    manager.destroy();
  });
});

describe('createDefaultNetworkMonitor', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('adapts NetInfo when it is installed', async () => {
    const remove = jest.fn();
    let listener: ((state: object) => void) | undefined;
    jest.doMock('@react-native-community/netinfo', () => ({
      __esModule: true,
      default: {
        fetch: async () => ({ isConnected: null, isInternetReachable: null }),
        addEventListener: (fn: (state: object) => void) => {
          listener = fn;
          return remove;
        },
      },
    }));

    const monitor = createDefaultNetworkMonitor();
    const seen: unknown[] = [];
    const unsubscribe = monitor.addEventListener((state) => seen.push(state));
    listener?.({ isConnected: true, isInternetReachable: true });

    expect(await monitor.fetch()).toEqual({ isConnected: false, isInternetReachable: null });
    expect(seen).toEqual([{ isConnected: true, isInternetReachable: true }]);
    unsubscribe();
    expect(remove).toHaveBeenCalled();
    jest.dontMock('@react-native-community/netinfo');
  });

  it('falls back to always-online without NetInfo', async () => {
    jest.doMock('@react-native-community/netinfo', () => {
      throw new Error('not installed');
    });

    const monitor = createDefaultNetworkMonitor();

    expect(await monitor.fetch()).toEqual({ isConnected: true, isInternetReachable: null });
    monitor.addEventListener(() => undefined)();
    jest.dontMock('@react-native-community/netinfo');
  });
});
