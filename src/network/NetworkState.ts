import type { NetworkState } from '../types';

/** Conservative default assumed before the first real network state is known. */
export const UNKNOWN_NETWORK_STATE: NetworkState = {
  isConnected: true,
  isInternetReachable: null,
};

/**
 * Derives a single online/offline boolean from a NetworkState. Reachability
 * `null` (undetermined, common right after a connectivity change) is treated
 * as online-optimistic when the device reports a connection, so a real
 * request attempt — not a guess — is what ultimately proves connectivity.
 */
export function isOnlineState(state: NetworkState): boolean {
  if (!state.isConnected) {
    return false;
  }
  return state.isInternetReachable !== false;
}
