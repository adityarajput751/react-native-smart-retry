import { SmartRetryClient } from './SmartRetry';

/**
 * The default SmartRetry singleton. Configure it once at startup:
 *
 * ```ts
 * import { SmartRetry } from 'react-native-smart-retry';
 *
 * SmartRetry.configure({ baseURL: 'https://api.example.com' });
 *
 * const result = await SmartRetry.request({
 *   url: '/attendance',
 *   method: 'POST',
 *   data: { employeeId: 123 },
 *   queue: true,
 * });
 * ```
 */
export const SmartRetry = new SmartRetryClient();
