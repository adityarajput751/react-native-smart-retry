# Changelog

All notable changes to this project are documented in this file.

## 0.2.0

### Added

- `useSmartRetryQueue()` React hook: live queue, counts, connectivity, and sync state.
- `beforeRequest` hook, run before every attempt including replays, for attaching fresh auth tokens.
- `onUnauthorized` hook: refresh a session on `401` and retry once. Concurrent `401`s share one refresh.
- `baseURL` config.
- `retryFailed(id?)` to put failed requests back in the queue.
- `maxQueueSize` and `maxRequestAge` to bound storage use.
- `SmartRetry.on(event, listener)` for multiple subscribers, including a new `queueChanged` event.
- `SmartRetry.isProcessing()` and `getQueueCount(status)`.
- Failed results and `onFailure` now include the response body as `error.data`. It is never persisted.
- Success results now include `httpStatus` and `headers`.
- `FormData`, `Blob`, and `ArrayBuffer` bodies on immediate requests.
- Per-request `strategy`, `baseDelay`, and `maxDelay` now apply to replays.

### Fixed

- A request could be permanently lost if the queue was read while it was being stored.
- The queue stopped permanently after `destroy()` then `initialize()`, which happens under React StrictMode.
- A 2xx with an empty or invalid JSON body was treated as a failure, so a successful `POST` could be sent again.
- All API calls waited for the backlog to drain at startup.
- One storage error during startup made every later call reject.
- `clearQueue()` and `remove()` did not stop a running sync. They now also abort the matching in-flight replay.
- Requests added during a sync waited for an unrelated trigger.
- A network failure while the device reported online stalled the queue. It now retries with backoff.
- Requests cancelled through `signal` were queued and replayed.
- `uniqueKey` did not stop concurrent duplicates.
- `Retry-After` was ignored on the first replay of a queued request.
- A request interrupted by a crash waited 60 seconds and lost its FIFO position.
- `configure({ timeout })` was ignored for immediate requests.
- A throwing event callback could mark a successful request as failed.
- React Native's `Network request timed out` was classified as `UNKNOWN`, which failed the request permanently.
- Importing the package threw when AsyncStorage was missing, even with custom storage.
- Storage and network warnings never appeared with `debug: true`.
- A corrupted queue index is now rebuilt from stored items when the backend supports `getAllKeys`.

### Changed

- `request()` and `queue()` resolve with a `failed` result instead of rejecting when a request cannot be stored.
- `initialize()` no longer waits for the queue to drain. Use `await processQueue()` for that.
- Caller cancellation is reported as reason `ABORTED`, not `TIMEOUT`.
- `queue: true` only stores failures that can succeed on replay, so errors like `501` now return `failed`.
- `processQueue()` ignores backoff delays.
- A queue launched in the background now stays paused when `pauseWhenBackgrounded` is on.
- `staleProcessingThresholdMs` is deprecated and has no effect.
- `lib/` is no longer committed. It is built when the package is packed.

## 0.1.1

- No source changes from 0.1.0.

## 0.1.0 — Initial release

- Persistent, FIFO offline request queue backed by a pluggable `QueueStorage` abstraction (AsyncStorage implementation included).
- `SmartRetry.request()` / `SmartRetry.queue()` public API with explicit, opt-in queueing (`queue: true`) — no request is queued automatically.
- Automatic queue processing on reconnect via a pluggable, event-driven `NetworkManager` (NetInfo-backed by default).
- Configurable retry engine: `fixed` / `linear` / `exponential` / `exponential-jitter` strategies, `Retry-After` support, per-request and global overrides.
- HTTP method safety gating for automatic retries (`retryMethods`) on the immediate request path.
- Error classification (`NETWORK_ERROR`, `TIMEOUT`, `SERVER_ERROR`, `RATE_LIMIT`, `CLIENT_ERROR`, `UNKNOWN`) driving retry/queue/fail decisions.
- Duplicate protection via `uniqueKey`, and `idempotencyKey` propagation as an `Idempotency-Key` header.
- Stale "processing" recovery on initialize (crash/kill mid-request), app-restart-safe persistence.
- `AppState`-aware pause/resume of queue processing (`pauseWhenBackgrounded`).
- Debug logging (metadata only — never headers, payloads, or tokens) and a full event set (`onQueued`, `onRetry`, `onSuccess`, `onFailure`, `onQueueStart`, `onQueueComplete`, `onNetworkChange`).
- Example app and full test suite.
