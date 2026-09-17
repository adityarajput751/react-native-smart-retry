import { SmartRetryClient } from './core/SmartRetry';

/**
 * The default SmartRetry singleton. Call `SmartRetry.initialize()` once near
 * your app's root (e.g. in a top-level `useEffect`) before issuing requests.
 *
 * ```ts
 * import { SmartRetry } from 'react-native-smart-retry';
 *
 * await SmartRetry.initialize();
 *
 * const result = await SmartRetry.request({
 *   url: 'https://api.example.com/attendance',
 *   method: 'POST',
 *   data: { employeeId: 123 },
 *   queue: true,
 * });
 * ```
 */
export const SmartRetry = new SmartRetryClient();
export { SmartRetryClient, createSmartRetry } from './core/SmartRetry';
export { AsyncStorageStorage } from './storage/AsyncStorageStorage';
export { NetworkManager, createDefaultNetworkMonitor } from './network/NetworkManager';
export { isOnlineState } from './network/NetworkState';
export { RetryEngine } from './retry/RetryEngine';
export { calculateDelay } from './retry/calculateDelay';
export { DEFAULT_RETRY_POLICY, isMethodRetryable, SAFE_RETRY_METHODS } from './retry/RetryPolicy';
export { DEFAULT_NON_RETRYABLE_STATUS_CODES, DEFAULT_RETRYABLE_STATUS_CODES, classifyStatusError, classifyThrownError, isRetryable, parseRetryAfter, serializeError } from './errors/ErrorClassifier';
export { RetryError } from './errors/RetryError';
export { AppLifecycleManager } from './lifecycle/AppLifecycleManager';
export { FetchAdapter } from './adapters/FetchAdapter';
//# sourceMappingURL=index.js.map