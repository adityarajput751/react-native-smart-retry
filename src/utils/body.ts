/** True for bodies `fetch` sends as-is and that cannot be written to the JSON queue (uploads). */
export function isBinaryBody(data: unknown): data is FormData | Blob | ArrayBuffer {
  return (
    (typeof FormData !== 'undefined' && data instanceof FormData) ||
    (typeof Blob !== 'undefined' && data instanceof Blob) ||
    (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer)
  );
}
