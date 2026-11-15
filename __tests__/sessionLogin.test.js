// Login against the real address validation and session middleware, with the
// chain data provider calls (validateDrep, fetchCalidusKey) mocked at the
// helpers module boundary.

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { bech32 } from 'bech32';

process.env.JWT_SECRET = 'x'.repeat(40);
process.env.NETWORK_ID = '0';
process.env.WALLETSIGNER_MULTISIG = 'true';

const actualCardano = await import('@lerna-labs/ekklesia-helpers/cardano');
const { ProviderError, ProviderRateLimitError } = actualCardano;

const encode = (prefix, hex) => bech32.encode(prefix, bech32.toWords(Buffer.from(hex, 'hex')), 256);
const DREP = encode('drep', `22${'ab'.repeat(28)}`);
const DREP_SCRIPT = encode('drep', `23${'cd'.repeat(28)}`);
const STAKE = encode('stake_test', `e0${'ef'.repeat(28)}`);
const POOL = encode('pool', '12'.repeat(28));
const BALLOT_ID = new mongoose.Types.ObjectId();

const validateDrep = jest.fn();
const fetchCalidusKey = jest.fn();
await jest.unstable_mockModule('@lerna-labs/ekklesia-helpers/cardano', () => ({
  ...actualCardano,
  validateDrep,
  fetchCalidusKey,
  fetchName: jest.fn().mockResolvedValue(null),
  getScript: jest.fn().mockResolvedValue(false),
}));

const verifySignature = jest.fn();
const isPartyToScript = jest.fn();
await jest.unstable_mockModule('../helper/verifySignature.js', () => ({
  verifySignature,
  isPartyToScript,
  validateScriptSignatures: jest.fn(),
}));

const passthrough = (_req, _res, next) => next();
await jest.unstable_mockModule('../helper/rateLimiters.js', () => ({
  nonceRequestLimiter: passthrough,
  sessionVerificationLimiter: passthrough,
  getSessionLimiter: passthrough,
  publicGetLimiter: passthrough,
}));

let tokenUserId = POOL;
await jest.unstable_mockModule('../helper/verifyToken.js', () => ({
  verifyToken: () => ({
    status: 'success',
    userId: tokenUserId,
    signType: 'pool',
    multiSig: false,
  }),
}));
await jest.unstable_mockModule('../helper/idResolver.js', () => ({
  resolveBallot: async () => ({ doc: { _id: BALLOT_ID, status: 'live' }, source: 'internal' }),
  resolveProposal: async () => null,
}));

const { default: express } = await import('express');
const { Session } = await import('../schema/Session.js');
const { User } = await import('../schema/User.js');
const { default: sessionRouter } = await import('../routes/api/v0/session.js');
const { default: dashboardRouter } = await import('../routes/api/v0/dashboard.js');
const { PROVIDER_UNAVAILABLE_MESSAGE } = await import('../helper/providerFailure.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/session', sessionRouter);
  app.use('/dashboard', dashboardRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  validateDrep.mockReset();
  fetchCalidusKey.mockReset();
  verifySignature.mockReset().mockResolvedValue(true);
  isPartyToScript.mockReset().mockResolvedValue(true);
  jest.spyOn(Session, 'findOneAndUpdate').mockResolvedValue({ nonce: 'nonce' });
  jest.spyOn(Session, 'updateMany').mockResolvedValue({});
  jest.spyOn(Session, 'deleteMany').mockResolvedValue({});
  jest.spyOn(Session.prototype, 'save').mockResolvedValue({});
  jest.spyOn(User, 'findOneAndUpdate').mockResolvedValue({});
  jest.spyOn(User, 'updateOne').mockResolvedValue({});
  jest.spyOn(User, 'findById').mockReturnValue({ lean: async () => ({ nativeScript: {} }) });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const send = (method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const signature = { key: 'abc', signature: 'def' };
const putStandalone = (signerAddress, signType) =>
  send('PUT', '/session', { signerAddress, signType, signature });
const putMultisig = (scriptAddress) =>
  send('PUT', '/session', {
    signerAddress: STAKE,
    signType: 'stake',
    scriptAddress,
    signature,
  });

describe('PUT /session, standalone DRep', () => {
  test('a registered DRep gets a session', async () => {
    validateDrep.mockResolvedValue(true);
    const res = await putStandalone(DREP, 'drep');
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe(DREP);
    expect(validateDrep).toHaveBeenCalledWith(DREP);
  });

  test('an unregistered DRep is refused with 403 and no session', async () => {
    validateDrep.mockResolvedValue(false);
    const res = await putStandalone(DREP, 'drep');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toMatch(/not registered/i);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a provider failure answers 503, not "not registered"', async () => {
    validateDrep.mockRejectedValue(new ProviderRateLimitError('koios', 'slow down', 429, 9));
    const res = await putStandalone(DREP, 'drep');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('9');
    expect((await res.json()).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('an unexpected error is not reported as a registration result', async () => {
    validateDrep.mockRejectedValue(new Error('No Cardano provider configured.'));
    const res = await putStandalone(DREP, 'drep');
    expect(res.status).toBe(500);
  });

  test('a stake login does not check DRep registration', async () => {
    const res = await putStandalone(STAKE, 'stake');
    expect(res.status).toBe(200);
    expect(validateDrep).not.toHaveBeenCalled();
  });
});

describe('PUT /session, multisig DRep script', () => {
  test('a registered DRep script gets a session', async () => {
    validateDrep.mockResolvedValue(true);
    const res = await putMultisig(DREP_SCRIPT);
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe(DREP_SCRIPT);
    expect(validateDrep).toHaveBeenCalledWith(DREP_SCRIPT);
  });

  test('an unregistered DRep script is refused with 403', async () => {
    validateDrep.mockResolvedValue(false);
    const res = await putMultisig(DREP_SCRIPT);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/not registered/i);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a provider failure answers 503', async () => {
    validateDrep.mockRejectedValue(new ProviderError('koios', 'down'));
    const res = await putMultisig(DREP_SCRIPT);
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('a stake script does not check DRep registration', async () => {
    const stakeScript = encode('stake_test', `f0${'cd'.repeat(28)}`);
    const res = await putMultisig(stakeScript);
    expect(res.status).toBe(200);
    expect(validateDrep).not.toHaveBeenCalled();
  });

  test('a signature that does not verify is refused before the registration check', async () => {
    isPartyToScript.mockResolvedValue(false);
    const res = await putMultisig(DREP_SCRIPT);
    expect(res.status).toBe(400);
    expect(validateDrep).not.toHaveBeenCalled();
  });
});

describe('Calidus key lookup', () => {
  const postNonce = () => send('POST', '/session', { signerAddress: POOL, signType: 'pool' });
  const postCheckout = () =>
    send('POST', `/dashboard/${BALLOT_ID.toString()}/checkout/`, {
      signerAddress: POOL,
      signType: 'pool',
    });

  test.each([
    ['session nonce', postNonce],
    ['checkout', postCheckout],
  ])('%s: no registered key answers 400', async (_name, call) => {
    fetchCalidusKey.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Pool not found or no calidus key registered');
  });

  test.each([
    ['session nonce', postNonce],
    ['checkout', postCheckout],
  ])('%s: a provider failure answers 503', async (_name, call) => {
    fetchCalidusKey.mockRejectedValue(new ProviderError('koios', 'down'));
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe(PROVIDER_UNAVAILABLE_MESSAGE);
  });

  test('session nonce: a registered key is returned as calidusID', async () => {
    fetchCalidusKey.mockResolvedValue({ calidus_id_bech32: 'calidus1abc' });
    const res = await postNonce();
    expect(res.status).toBe(200);
    expect((await res.json()).calidusID).toBe('calidus1abc');
  });
});
