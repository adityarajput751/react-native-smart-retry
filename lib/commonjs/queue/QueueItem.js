"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createQueueItem = createQueueItem;
exports.sortByCreatedAt = sortByCreatedAt;
var _id = require("../utils/id");
/** Builds a fresh {@link QueuedRequest} record from request options. */
function createQueueItem(options) {
  const now = Date.now();
  return {
    id: (0, _id.generateRequestId)(),
    url: options.url,
    method: options.method,
    headers: options.headers,
    data: options.data,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    status: 'pending',
    uniqueKey: options.uniqueKey,
    idempotencyKey: options.idempotencyKey,
    timeout: options.timeout,
    maxRetries: options.retries,
    retryOnStatusCodes: options.retryOnStatusCodes
  };
}

/** Sorts requests oldest-first, so FIFO processing order is always by creation time. */
function sortByCreatedAt(requests) {
  return [...requests].sort((a, b) => a.createdAt - b.createdAt);
}
//# sourceMappingURL=QueueItem.js.map