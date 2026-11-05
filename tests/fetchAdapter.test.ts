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

    const promise = adapter.execute({
      url: 'https://api.example.com/x',
      method: 'GET',
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ reason: 'ABORTED', isTimeout: false });
  });

  it('classifies a non-2xx response using the status code', async () => {
    installMockFetch([{ type: 'response', status: 400, body: { message: 'bad' } }]);
    const adapter = new FetchAdapter();

    await expect(adapter.execute({ url: 'https://api.example.com/x', method: 'POST' })).rejects.toMatchObject(
      {
        reason: 'CLIENT_ERROR',
        status: 400,
      }
    );
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

describe('FetchAdapter response bodies', () => {
  const stubFetch = (response: Partial<Response>): void => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      ...response,
    }));
  };
  const lostBody = { text: () => Promise.reject(new TypeError('Network request failed')) };

  it('returns invalid JSON from a 2xx as text rather than failing', async () => {
    stubFetch({ text: async () => '<html>' });
    const result = await new FetchAdapter().execute({ url: 'https://x.test', method: 'POST' });
    expect(result.data).toBe('<html>');
  });

  it('parses +json content types', async () => {
    stubFetch({
      headers: new Headers({ 'content-type': 'application/problem+json' }),
      text: async () => '{"a":1}',
    });
    const result = await new FetchAdapter().execute({ url: 'https://x.test', method: 'GET' });
    expect(result.data).toEqual({ a: 1 });
  });

  it('keeps a POST successful when its response body is lost, so it is not replayed', async () => {
    stubFetch(lostBody);
    const result = await new FetchAdapter().execute({ url: 'https://x.test', method: 'POST' });
    expect(result).toMatchObject({ status: 200, data: undefined });
  });

  it('fails a GET whose response body is lost, since retrying is safe', async () => {
    stubFetch(lostBody);
    await expect(new FetchAdapter().execute({ url: 'https://x.test', method: 'GET' })).rejects.toMatchObject({
      reason: 'NETWORK_ERROR',
    });
  });

  it('sends FormData untouched, without a JSON content type', async () => {
    stubFetch({ text: async () => '' });
    const data = new FormData();
    await new FetchAdapter().execute({ url: 'https://x.test', method: 'POST', data });
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(data);
    expect(init.headers).toEqual({});
  });
});
