// Regression coverage for code-scanning alert #2 (js/request-forgery).
//
// POST /api/v1/admin/ballots/:id/prepare let an admin-supplied `endpoint`
// flow straight into the outbound Hydra request URL with no validation.
// helper/hydraRegistry.js now canonicalizes every endpoint with `new URL()`
// and confirms it matches one of the operator's already-configured Hydra
// instances (the HYDRA_API_KEY_<SLUG> env vars) before hydraClient ever
// builds a URL from it.

import { jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadRegistry() {
  jest.resetModules();
  return import('../../helper/hydraRegistry.js');
}

async function expectRejected(endpoint, code) {
  const { resolveByEndpoint } = await loadRegistry();
  expect.assertions(1);
  try {
    resolveByEndpoint(endpoint);
  } catch (err) {
    expect(err.code).toBe(code);
  }
}

describe('hydraRegistry endpoint allowlist (security)', () => {
  test('a configured endpoint resolves and returns its api key', async () => {
    process.env.HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001 = 'configured-key';
    const { resolveByEndpoint } = await loadRegistry();
    const result = resolveByEndpoint('http://hydra.allowed:7001');
    expect(result).toEqual({ endpoint: 'http://hydra.allowed:7001', apiKey: 'configured-key' });
  });

  test('a trailing slash still resolves to the same configured instance', async () => {
    process.env.HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001 = 'configured-key';
    const { resolveByEndpoint } = await loadRegistry();
    const result = resolveByEndpoint('http://hydra.allowed:7001/');
    expect(result.endpoint).toBe('http://hydra.allowed:7001');
  });

  test('rejects an endpoint pointing at a host with no configured key', () =>
    expectRejected('http://attacker.evil', 'ENDPOINT_NOT_ALLOWED'));

  test('rejects an absolute URL for a different, unconfigured Hydra-shaped host', async () => {
    process.env.HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001 = 'configured-key';
    await expectRejected('http://hydra.attacker.evil:7001', 'ENDPOINT_NOT_ALLOWED');
  });

  test('rejects an endpoint that smuggles a different host past the allowed one via userinfo', async () => {
    process.env.HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001 = 'configured-key';
    // Looks like it starts with the allowed origin, but "hydra.allowed:7001"
    // parses as userinfo and the real host is attacker.evil.
    await expectRejected('http://hydra.allowed:7001@attacker.evil/', 'INVALID_ENDPOINT');
  });

  test('rejects a path appended past an otherwise-configured origin', async () => {
    process.env.HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001 = 'configured-key';
    await expectRejected('http://hydra.allowed:7001/../internal', 'INVALID_ENDPOINT');
  });

  test('rejects a non-http(s) scheme', () => expectRejected('file:///etc/passwd', 'INVALID_ENDPOINT'));

  test('rejects a value that is not a URL at all', () =>
    expectRejected('not-a-url', 'INVALID_ENDPOINT'));

  test('rejects an empty endpoint before any URL parsing', async () => {
    const { resolveByEndpoint, HydraRegistryError } = await loadRegistry();
    expect(() => resolveByEndpoint('')).toThrow(HydraRegistryError);
    try {
      resolveByEndpoint('');
    } catch (err) {
      expect(err.code).toBe('NO_ENDPOINT');
    }
  });
});
