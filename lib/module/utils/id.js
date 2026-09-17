/**
 * Generates a unique, sortable-enough request id. Not cryptographically
 * secure — only needs to be unique within a single device's queue.
 */
export function generateRequestId() {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `req_${timePart}_${randomPart}`;
}
//# sourceMappingURL=id.js.map