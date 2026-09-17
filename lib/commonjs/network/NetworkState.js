"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.UNKNOWN_NETWORK_STATE = void 0;
exports.isOnlineState = isOnlineState;
/** Conservative default assumed before the first real network state is known. */
const UNKNOWN_NETWORK_STATE = exports.UNKNOWN_NETWORK_STATE = {
  isConnected: true,
  isInternetReachable: null
};

/**
 * Derives a single online/offline boolean from a NetworkState. Reachability
 * `null` (undetermined, common right after a connectivity change) is treated
 * as online-optimistic when the device reports a connection, so a real
 * request attempt — not a guess — is what ultimately proves connectivity.
 */
function isOnlineState(state) {
  if (!state.isConnected) {
    return false;
  }
  return state.isInternetReachable !== false;
}
//# sourceMappingURL=NetworkState.js.map