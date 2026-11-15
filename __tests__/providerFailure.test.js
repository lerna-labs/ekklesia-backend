import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import {
  ProviderError,
  ProviderAuthError,
  ProviderRateLimitError,
} from '@lerna-labs/ekklesia-helpers/cardano';

const BALLOT_ID = new mongoose.Types.ObjectId();
const USER_ID = 'drep1testuser';
const MERKLE_ROOT = `0x${'ab'.repeat(32)}`;
const PROVIDER_MESSAGE = 'Koios account suspended: billing overdue';

await jest.unstable_mockModule('../helper/verifyToken.js', () => ({
  verifyToken: () => ({ status: 'success', userId: USER_ID, signType: 'drep', multiSig: false }),
}));

await jest.unstable_mockModule('../helper/idResolver.js', () => ({
  resolveBallot: async () => ({ doc: { _id: BALLOT_ID, status: 'live' }, source: 'internal' }),
  resolveProposal: async () => null,
}));

await jest.unstable_mockModule('../helper/validateAddress.js', () => ({
  validateAddress: (addr) => addr,
  getAddressType: () => ({}),
}));

const verifySignature = jest.fn();
await jest.unstable_mockModule('../helper/verifySignature.js', () => ({
  verifySignature,
  isPartyToScript: jest.fn(),
  validateScriptSignatures: jest.fn(),
}));

const { default: express } = await import('express');
const { UserCache } = await import('../schema/UserCache.js');
const { Transaction } = await import('../schema/Transaction.js');
const { default: dashboardRouter } = await import('../routes/api/v0/dashboard.js');
const { respondToProviderFailure, PROVIDER_UNAVAILABLE_MESSAGE, PROVIDER_CREDENTIAL_ALERT_TAG } =
  await import('../helper/providerFailure.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/dashboard', dashboardRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(UserCache, 'findOne').mockResolvedValue({ validated: true });
  jest.spyOn(Transaction, 'findOne').mockResolvedValue({ merkleRoot: MERKLE_ROOT, votes: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function putCheckout() {
  return fetch(`${baseUrl}/dashboard/${BALLOT_ID.toString()}/checkout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signerAddress: USER_ID,
      signType: 'drep',
      data: MERKLE_ROOT,
      signature: { publicKey: 'abc', signature: 'def' },
    }),
  });
}

describe('provider failures on PUT /:ballotId/checkout', () => {
  test('a credential rejection answers 503, hides the provider message and raises the alert', async () => {
    verifySignature.mockRejectedValue(new ProviderAuthError('koios', PROVIDER_MESSAGE, 403));
    const res = await putCheckout();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    const text = await res.text();
    expect(text).not.toContain(PROVIDER_MESSAGE);
    expect(JSON.parse(text).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
    const alerted = errorSpy.mock.calls.some(
      ([line]) => line.includes(PROVIDER_CREDENTIAL_ALERT_TAG) && line.includes(PROVIDER_MESSAGE),
    );
    expect(alerted).toBe(true);
  });

  test('a throttling response answers 503 with Retry-After when the provider gave a delay', async () => {
    verifySignature.mockRejectedValue(
      new ProviderRateLimitError('koios', PROVIDER_MESSAGE, 429, 17),
    );
    const res = await putCheckout();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('17');
    const text = await res.text();
    expect(text).not.toContain(PROVIDER_MESSAGE);
    expect(JSON.parse(text).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
    expect(
      errorSpy.mock.calls.some(([line]) => String(line).includes(PROVIDER_CREDENTIAL_ALERT_TAG)),
    ).toBe(false);
  });

  test('a throttling response without a delay sets no Retry-After', async () => {
    verifySignature.mockRejectedValue(new ProviderRateLimitError('koios', PROVIDER_MESSAGE, 402));
    const res = await putCheckout();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  test('a transient outage answers 503 and hides the provider message', async () => {
    verifySignature.mockRejectedValue(new ProviderError('koios', PROVIDER_MESSAGE));
    const res = await putCheckout();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(PROVIDER_MESSAGE);
    expect(JSON.parse(text).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
    expect(
      errorSpy.mock.calls.some(([line]) => String(line).includes(PROVIDER_CREDENTIAL_ALERT_TAG)),
    ).toBe(false);
  });
});

describe('respondToProviderFailure', () => {
  test('leaves any other error to the caller and sends nothing', () => {
    const res = { set: jest.fn(), status: jest.fn() };
    expect(respondToProviderFailure(res, new Error('boom'), 'ctx')).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });
});
