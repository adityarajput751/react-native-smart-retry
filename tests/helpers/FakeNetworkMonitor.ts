import type { NetworkMonitor } from '../../src/network/NetworkManager';
import type { NetworkState } from '../../src/types';

/** Controllable, push-based network monitor for tests — no real connectivity involved. */
export class FakeNetworkMonitor implements NetworkMonitor {
  private state: NetworkState;
  private readonly listeners = new Set<(state: NetworkState) => void>();

  constructor(initial: NetworkState = { isConnected: true, isInternetReachable: true }) {
    this.state = initial;
  }

  async fetch(): Promise<NetworkState> {
    return this.state;
  }

  addEventListener(listener: (state: NetworkState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setState(state: NetworkState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }

  goOffline(): void {
    this.setState({ isConnected: false, isInternetReachable: false });
  }

  goOnline(): void {
    this.setState({ isConnected: true, isInternetReachable: true });
  }
}
