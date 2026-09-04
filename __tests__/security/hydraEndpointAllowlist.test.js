// Regression coverage for code-scanning alert #2 (js/request-forgery).
//
// POST /api/v1/admin/ballots/:id/prepare let an admin-supplied `endpoint`
// flow into the outbound Hydra request URL. helper/hydraRegistry.js now
// resolves that value against HYDRA_ALLOWED_ENDPOINTS and hands back the
// configured entry rather than the caller's string, so no value derived
// from a request is ever used to build an outbound URL.

import { jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

const ALLOWED = 'http://hydra.allowed:7001';
const ALLOWED_KEY_VAR = 'HYDRA_API_KEY_HTTP_HYDRA_ALLOWED_7001';
const SECOND = 'https://hydra.second.internal';
const SECOND_KEY_VAR = 'HYDRA_API_KEY_HTTPS_HYDRA_SECOND_INTERNAL';

beforeEach(() => {
  delete process.env.HYDRA_ALLOWED_ENDPOINTS;
  delete process.env.HYDRA_DEFAULT_ENDPOINT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadRegistry() {
  jest.resetModules();
  return import('../../helper/hydraRegistry.js');
}

function configureAllowed() {
  process.env.HYDRA_ALLOWED_ENDPOINTS = ALLOWED;
  process.env[ALLOWED_KEY_VAR] = 'configured-key';
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
    configureAllowed();
    const { resolveByEndpoint } = await loadRegistry();
    expect(resolveByEndpoint(ALLOWED)).toEqual({ endpoint: ALLOWED, apiKey: 'configured-key' });
  });

  test('equivalent spellings all resolve to the one canonical configured origin', async () => {
    configureAllowed();
    const { resolveByEndpoint } = await loadRegistry();
    for (const spelling of [ALLOWED, `${ALLOWED}/`, 'http://HYDRA.ALLOWED:7001']) {
      expect(resolveByEndpoint(spelling).endpoint).toBe(ALLOWED);
    }
  });

  test('selects the right instance when several are configured', async () => {
    process.env.HYDRA_ALLOWED_ENDPOINTS = `${ALLOWED}, ${SECOND}`;
    process.env[ALLOWED_KEY_VAR] = 'first-key';
    process.env[SECOND_KEY_VAR] = 'second-key';
    const { resolveByEndpoint } = await loadRegistry();
    expect(resolveByEndpoint(SECOND)).toEqual({ endpoint: SECOND, apiKey: 'second-key' });
    expect(resolveByEndpoint(ALLOWED)).toEqual({ endpoint: ALLOWED, apiKey: 'first-key' });
  });

  test('falls back to HYDRA_DEFAULT_ENDPOINT when no allowlist is set', async () => {
    process.env.HYDRA_DEFAULT_ENDPOINT = ALLOWED;
    process.env[ALLOWED_KEY_VAR] = 'configured-key';
    const { resolveByEndpoint } = await loadRegistry();
    expect(resolveByEndpoint(ALLOWED).endpoint).toBe(ALLOWED);
  });

  test('rejects everything when neither the allowlist nor a default is set', () =>
    expectRejected(ALLOWED, 'ENDPOINT_NOT_ALLOWED'));

  test('rejects an endpoint pointing at a host that is not on the allowlist', async () => {
    configureAllowed();
    await expectRejected('http://attacker.evil', 'ENDPOINT_NOT_ALLOWED');
  });

  test('rejects an absolute URL for a different, unconfigured Hydra-shaped host', async () => {
    configureAllowed();
    await expectRejected('http://hydra.attacker.evil:7001', 'ENDPOINT_NOT_ALLOWED');
  });

  test('rejects an allowlisted host reached over a scheme that was not allowlisted', async () => {
    configureAllowed();
    await expectRejected('https://hydra.allowed:7001', 'ENDPOINT_NOT_ALLOWED');
  });

  test('rejects an allowlisted host on a port that was not allowlisted', async () => {
    configureAllowed();
    await expectRejected('http://hydra.allowed:7002', 'ENDPOINT_NOT_ALLOWED');
  });

  test('rejects an endpoint that smuggles a different host past the allowed one via userinfo', async () => {
    configureAllowed();
    // Looks like it starts with the allowed origin, but "hydra.allowed:7001"
    // parses as userinfo and the real host is attacker.evil.
    await expectRejected('http://hydra.allowed:7001@attacker.evil/', 'INVALID_ENDPOINT');
  });

  test('rejects a path appended past an otherwise-configured origin', async () => {
    configureAllowed();
    await expectRejected('http://hydra.allowed:7001/../internal', 'INVALID_ENDPOINT');
  });

  test('rejects a non-http(s) scheme', () =>
    expectRejected('file:///etc/passwd', 'INVALID_ENDPOINT'));

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

  test('an allowlisted endpoint with no provisioned key fails as unconfigured', async () => {
    process.env.HYDRA_ALLOWED_ENDPOINTS = ALLOWED;
    await expectRejected(ALLOWED, 'ENDPOINT_NOT_CONFIGURED');
  });

  test('a malformed allowlist entry fails loudly rather than narrowing the allowlist', async () => {
    process.env.HYDRA_ALLOWED_ENDPOINTS = `${ALLOWED}, not-a-url`;
    process.env[ALLOWED_KEY_VAR] = 'configured-key';
    await expectRejected(ALLOWED, 'INVALID_ALLOWLIST_ENTRY');
  });
});
