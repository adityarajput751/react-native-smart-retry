# Changelog

All notable changes to this project are documented in this file.

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
