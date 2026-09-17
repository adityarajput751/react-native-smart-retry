import type { NetworkState, QueuedRequest, RetryInfo, SerializedError } from '../types';
export interface QueueEventMap {
    queued: QueuedRequest;
    retry: RetryInfo;
    success: {
        request: QueuedRequest;
        response: unknown;
    };
    failure: {
        request: QueuedRequest;
        error: SerializedError;
    };
    queueStart: undefined;
    queueComplete: {
        processed: number;
        succeeded: number;
        failed: number;
    };
    networkChange: NetworkState;
}
type EventListener<T> = (payload: T) => void;
/** Small internal typed event emitter used to bridge queue/network activity to configured callbacks. */
export declare class QueueEventEmitter {
    private readonly listeners;
    on<K extends keyof QueueEventMap>(event: K, listener: EventListener<QueueEventMap[K]>): () => void;
    emit<K extends keyof QueueEventMap>(event: K, payload: QueueEventMap[K]): void;
    removeAllListeners(): void;
}
export {};
//# sourceMappingURL=QueueEvents.d.ts.map