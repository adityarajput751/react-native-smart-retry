import { FetchAdapter } from '../src/adapters/FetchAdapter';
import { RetryError } from '../src/errors/RetryError';
import { installMockFetch } from './helpers/mockFetch';

describe('FetchAdapter', () => {
  it('returns parsed JSON data on a successful response', async () => {
    const mock = installMockFetch([{ type: 'response', status: 200, body: { hello: 'world' } }]);
    const adapter = new FetchAdapter();

    const result = await adapter.execute({ url: 'https://api.example.com/x', method: 'GET' });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ hello: 'world' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('throws a classified NETWORK_ERROR when fetch rejects with a connectivity failure', async () => {
    installMockFetch([{ type: 'network-error' }]);
    const adapter = new FetchAdapter();

    await expect(adapter.execute({ url: 'https://api.example.com/x', method: 'GET' })).rejects.toMatchObject({
      reason: 'NETWORK_ERROR',
      isNetworkError: true,
    });
  });

  it('throws a classified TIMEOUT error when the request exceeds the timeout', async () => {
    installMockFetch([{ type: 'hang' }]);
    const adapter = new FetchAdapter();

    await expect(
      adapter.execute({ url: 'https://api.example.com/x', method: 'GET', timeout: 20 })
    ).rejects.toMatchObject({ reason: 'TIMEOUT', isTimeout: true });
  });

  it('aborts and rejects when the caller-supplied signal is aborted', async () => {
    installMockFetch([{ type: 'hang' }]);
    const adapter = new FetchAdapter();
    const controller = new AbortController();

    const promise = adapter.execute({ url: 'https://api.example.com/x', method: 'GET', signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ reason: 'TIMEOUT', isTimeout: true });
  });

  it('classifies a non-2xx response using the status code', async () => {
    installMockFetch([{ type: 'response', status: 400, body: { message: 'bad' } }]);
    const adapter = new FetchAdapter();

    await expect(adapter.execute({ url: 'https://api.example.com/x', method: 'POST' })).rejects.toMatchObject({
      reason: 'CLIENT_ERROR',
      status: 400,
    });
  });

  it('sends an Idempotency-Key header when idempotencyKey is provided', async () => {
    const mock = installMockFetch([{ type: 'response', status: 200, body: {} }]);
    const adapter = new FetchAdapter();

    await adapter.execute({
      url: 'https://api.example.com/x',
      method: 'POST',
      data: { a: 1 },
      idempotencyKey: 'abc-123',
    });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('abc-123');
  });

  it('propagates a Retry-After value via the classified error', async () => {
    installMockFetch([{ type: 'response', status: 429, headers: { 'Retry-After': '5' } }]);
    const adapter = new FetchAdapter();

    await expect(adapter.execute({ url: 'https://api.example.com/x', method: 'GET' })).rejects.toMatchObject({
      reason: 'RATE_LIMIT',
      retryAfterMs: 5000,
    });
  });

  it('rethrows a RetryError instance untouched', async () => {
    installMockFetch([{ type: 'response', status: 500 }]);
    const adapter = new FetchAdapter();
    try {
      await adapter.execute({ url: 'https://api.example.com/x', method: 'GET' });
      fail('expected execute() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RetryError);
    }
  });
});
