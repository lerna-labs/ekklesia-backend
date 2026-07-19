// Unit tests for helper/hydraClient.js. Uses a stubbed global.fetch so no
// real network is touched. We import forEndpoint (not forBallot) because
// registry-by-ballotId needs Mongo; the transport logic is identical.

import { jest } from '@jest/globals';

// Environment required by hydraRegistry.resolveByEndpoint — the resolver
// derives the env-var name from the full endpoint URL (non-alphanumerics
// → "_", upper-cased). All tests below use "http://hydra.example", whose
// slug is HYDRA_API_KEY_HTTP_HYDRA_EXAMPLE.
process.env.HYDRA_API_KEY_HTTP_HYDRA_EXAMPLE = 'test-api-key';

const { forEndpoint, HydraClientError } = await import('../helper/hydraClient.js');

function ok(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'SUCCESS', data: body, code: null, message: null }),
    text: async () => JSON.stringify(body),
  };
}
function upstreamError(status, body = {}) {
  return {
    ok: false,
    status,
    json: async () => ({
      status: 'ERROR',
      code: body.code || null,
      message: body.message || 'bad',
      data: body.data || null,
    }),
    text: async () => body.message || 'bad',
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('hydraClient transport', () => {
  test('sends x-api-key header and returns envelope data', async () => {
    const seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push({ url, init });
      return ok({ hello: 'world' });
    });
    const client = forEndpoint('http://hydra.example');
    const data = await client.health();
    expect(data).toEqual({ hello: 'world' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://hydra.example/health');
    expect(seen[0].init.method).toBe('GET');
    expect(seen[0].init.headers['x-api-key']).toBe('test-api-key');
  });

  test('surfaces ERROR envelope as HydraClientError', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ERROR',
        code: 'HEAD_CLOSED',
        message: 'Head is closed',
        data: null,
      }),
      text: async () => '',
    }));
    const client = forEndpoint('http://hydra.example');
    await expect(client.start()).rejects.toMatchObject({
      name: 'HydraClientError',
      code: 'HEAD_CLOSED',
      message: expect.stringContaining('Head is closed'),
    });
  });

  test('does not retry 4xx', async () => {
    const fetchSpy = jest.fn(async () => upstreamError(404, { message: 'not found' }));
    global.fetch = fetchSpy;
    const client = forEndpoint('http://hydra.example');
    await expect(client.ballot()).rejects.toBeInstanceOf(HydraClientError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('retries 5xx up to the configured count then gives up', async () => {
    const fetchSpy = jest.fn(async () => upstreamError(503, { message: 'overloaded' }));
    global.fetch = fetchSpy;
    const client = forEndpoint('http://hydra.example', { retries: 2 });
    await expect(client.ballot()).rejects.toBeInstanceOf(HydraClientError);
    // 1 initial + 2 retries = 3 total
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('POST serializes JSON body', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (url, init) => {
      capturedBody = init.body;
      return ok({ txId: 'abc' });
    });
    const client = forEndpoint('http://hydra.example');
    await client.vote({ voterId: 'drep1xxx', nonce: 2 });
    expect(JSON.parse(capturedBody)).toEqual({ voterId: 'drep1xxx', nonce: 2 });
  });

  test('mutating POSTs are one-shot by default (no retry on 5xx)', async () => {
    // /prepare, /vote, /start, etc. are not idempotent on Hydra — retrying
    // a dropped 5xx can double-mint tokens or resubmit a vote. The client
    // must NOT retry these by default.
    const fetchSpy = jest.fn(async () => upstreamError(503, { message: 'overloaded' }));
    global.fetch = fetchSpy;
    const client = forEndpoint('http://hydra.example'); // default retries
    await expect(client.prepare({})).rejects.toBeInstanceOf(HydraClientError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    await expect(client.vote({})).rejects.toBeInstanceOf(HydraClientError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('read-only /ledger POST is still retry-safe', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      if (calls < 3) return upstreamError(503, { message: 'overloaded' });
      return ok({ utxos: [], admin_wallet: 'addr1...' });
    });
    const client = forEndpoint('http://hydra.example');
    const data = await client.ledger({});
    expect(data).toEqual({ utxos: [], admin_wallet: 'addr1...' });
    expect(calls).toBe(3); // initial + 2 retries
  });

  test('network failure (thrown fetch) wraps as HydraClientError with cause', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('econnreset');
    });
    const client = forEndpoint('http://hydra.example', { retries: 0 });
    await expect(client.health()).rejects.toMatchObject({
      name: 'HydraClientError',
      message: expect.stringContaining('network error'),
    });
  });
});
