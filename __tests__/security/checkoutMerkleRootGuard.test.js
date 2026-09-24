// Regression coverage for CodeQL alerts #9 and #10 (js/sql-injection).

import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const BALLOT_ID = new mongoose.Types.ObjectId();
const USER_ID = 'drep1testuser';
const VALID_MERKLE_ROOT = `0x${'ab'.repeat(32)}`;

await jest.unstable_mockModule('../../helper/verifyToken.js', () => ({
  verifyToken: () => ({
    status: 'success',
    userId: USER_ID,
    signType: 'drep',
    multiSig: false,
  }),
}));

await jest.unstable_mockModule('../../helper/idResolver.js', () => ({
  resolveBallot: async () => ({
    doc: { _id: BALLOT_ID, status: 'live' },
    source: 'internal',
  }),
  resolveProposal: async () => null,
}));

await jest.unstable_mockModule('../../helper/validateAddress.js', () => ({
  validateAddress: (addr) => addr,
  getAddressType: () => ({}),
}));

await jest.unstable_mockModule('../../helper/verifySignature.js', () => ({
  verifySignature: jest.fn(),
  isPartyToScript: jest.fn().mockResolvedValue(true),
  validateScriptSignatures: jest.fn(),
}));

const { default: express } = await import('express');
const { UserCache } = await import('../../schema/UserCache.js');
const { Transaction } = await import('../../schema/Transaction.js');
const { default: dashboardRouter } = await import('../../routes/api/v0/dashboard.js');

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

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(UserCache, 'findOne').mockResolvedValue({ validated: true });
  jest.spyOn(Transaction, 'findOne').mockResolvedValue(null);
});

function putCheckout(data) {
  return fetch(`${baseUrl}/dashboard/${BALLOT_ID.toString()}/checkout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signerAddress: USER_ID,
      signType: 'drep',
      data,
      signature: { publicKey: 'abc', signature: 'def' },
    }),
  });
}

function putCheckoutMultisig(data) {
  return fetch(`${baseUrl}/dashboard/${BALLOT_ID.toString()}/checkout/multisig`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signerAddress: USER_ID,
      signType: 'drep',
      scriptAddress: 'stake_test1scriptaddress',
      data,
      signature: { publicKey: 'abc', signature: 'def' },
    }),
  });
}

describe('PUT /:ballotId/checkout merkleRoot guard (alert #9)', () => {
  test('an operator object as data is rejected before reaching the database', async () => {
    const res = await putCheckout({ $ne: null });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(Transaction.findOne).not.toHaveBeenCalled();
  });

  test('a malformed string is rejected before reaching the database', async () => {
    const res = await putCheckout('not-a-merkle-root');
    expect(res.status).toBe(400);
    expect(Transaction.findOne).not.toHaveBeenCalled();
  });

  test('a valid merkleRoot string reaches the database as an $eq-wrapped filter value', async () => {
    const res = await putCheckout(VALID_MERKLE_ROOT);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('Checkout data not found');
    expect(Transaction.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        status: 'created',
        merkleRoot: { $eq: VALID_MERKLE_ROOT },
      }),
    );
  });
});

describe('PUT /:ballotId/checkout/multisig merkleRoot guard (alert #10)', () => {
  test('an operator object as data is rejected before reaching the database', async () => {
    const res = await putCheckoutMultisig({ $ne: null });
    expect(res.status).toBe(400);
    expect(Transaction.findOne).not.toHaveBeenCalled();
  });

  test('a malformed string is rejected before reaching the database', async () => {
    const res = await putCheckoutMultisig('short');
    expect(res.status).toBe(400);
    expect(Transaction.findOne).not.toHaveBeenCalled();
  });

  test('a valid merkleRoot string reaches the database as an $eq-wrapped filter value', async () => {
    const res = await putCheckoutMultisig(VALID_MERKLE_ROOT);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('Checkout data not found');
    expect(Transaction.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        status: { $in: ['created', 'pending'] },
        merkleRoot: { $eq: VALID_MERKLE_ROOT },
      }),
    );
  });
});
