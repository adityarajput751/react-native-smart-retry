import { useCallback, useEffect, useRef, useState } from 'react';
import { SmartRetry } from '../core/instance';
import type { SmartRetryClient } from '../core/SmartRetry';
import type { QueuedRequest } from '../types';

export interface SmartRetryQueueState {
  /** Every stored request, oldest first. */
  queue: QueuedRequest[];
  /** Requests still waiting to be delivered. */
  pendingCount: number;
  /** Requests that gave up and need `SmartRetry.retryFailed()` or `remove()`. */
  failedCount: number;
  /** Current connectivity, or `null` until first known. */
  isOnline: boolean | null;
  /** Whether a queue pass is running right now. */
  isSyncing: boolean;
  /** Re-reads the queue from storage. Rarely needed: changes are picked up automatically. */
  refresh: () => Promise<void>;
}

/**
 * Live view of the offline queue for building sync badges and "pending" lists.
 * Pass a client from `createSmartRetry()` to observe it instead of the singleton.
 */
export function useSmartRetryQueue(client: SmartRetryClient = SmartRetry): SmartRetryQueueState {
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const latestRead = useRef(0);

  const refresh = useCallback(async () => {
    const read = ++latestRead.current;
    const [items, online] = await Promise.all([client.getQueue(), client.isOnline()]);
    // Reads can finish out of order; only the newest may update state.
    if (read === latestRead.current) {
      setQueue(items);
      setIsOnline(online);
      setIsSyncing(client.isProcessing());
    }
  }, [client]);

  useEffect(() => {
    const safeRefresh = (): void => {
      refresh().catch(() => undefined);
    };

    safeRefresh();
    const unsubscribers = [
      client.on('queueChanged', safeRefresh),
      client.on('networkChange', safeRefresh),
      client.on('queueStart', () => setIsSyncing(true)),
      client.on('queueComplete', () => setIsSyncing(false)),
    ];

    return () => {
      // Invalidate any read still running, so it cannot set state after unmount.
      latestRead.current++;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [client, refresh]);

  return {
    queue,
    pendingCount: queue.filter((request) => request.status !== 'failed').length,
    failedCount: queue.filter((request) => request.status === 'failed').length,
    isOnline,
    isSyncing,
    refresh,
  };
}
