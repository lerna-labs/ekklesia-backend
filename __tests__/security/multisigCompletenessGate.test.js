// Regression coverage for GHSA-c79q-wv76-985c.
//
// PUT /api/v0/dashboard/:ballotId/checkout/multisig decided whether a
// transaction had collected enough signatures by calling
// validateScriptSignatures and testing the result with
// `if (!multisigComplete)`. That function returns a boolean on a normal
// answer but an `{ error }` object when it cannot reach the chain data
// provider, and an object is truthy, so a provider outage fell through
// into the multisig-complete branch instead of the not-complete one.

import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const BALLOT_ID = new mongoose.Types.ObjectId();
const TRANSACTION_ID = new mongoose.Types.ObjectId();
const USER_ID = 'drep1testuser';

await jest.unstable_mockModule('../../helper/verifyToken.js', () => ({
  verifyToken: () => ({
    status: 'success',
    userId: USER_ID,
    signType: 'drep',
    multiSig: true,
  }),
}));

// getBallot's ballot lookup is orthogonal to the completeness gate under
// test, so it's stubbed rather than exercised against a live Mongo.
await jest.unstable_mockModule('../../helper/idResolver.js', () => ({
  resolveBallot: async () => ({
    doc: { _id: BALLOT_ID, status: 'live' },
    source: 'internal',
  }),
  resolveProposal: async () => null,
}));

await jest.unstable_mockModule('../../helper/validateAddress.js', () => ({
  validateAddress: () => ({}),
  getAddressType: () => ({}),
}));

const validateScriptSignatures = jest.fn();
await jest.unstable_mockModule('../../helper/verifySignature.js', () => ({
  verifySignature: jest.fn(),
  isPartyToScript: jest.fn().mockResolvedValue(true),
  validateScriptSignatures,
}));

const { default: express } = await import('express');
const { UserCache } = await import('../../schema/UserCache.js');
const { Transaction } = await import('../../schema/Transaction.js');
const { Vote } = await import('../../schema/Vote.js');
const { default: dashboardRouter } = await import('../../routes/api/v0/dashboard.js');

let server;
let baseUrl;

function freshTransaction() {
  return {
    _id: TRANSACTION_ID,
    userId: USER_ID,
    ballotId: BALLOT_ID,
    merkleRoot: 'deadbeef',
    multiSig: [],
    votes: [{ proposalId: new mongoose.Types.ObjectId(), vote: 'yes' }],
  };
}

async function putMultisig() {
  return fetch(`${baseUrl}/dashboard/${BALLOT_ID.toString()}/checkout/multisig`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signerAddress: 'drep1testuser',
      signType: 'drep',
      scriptAddress: 'stake_test1scriptaddress',
      data: 'deadbeef',
      signature: { publicKey: 'abc', signature: 'def' },
    }),
  });
}

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
  jest.spyOn(UserCache, 'findOne').mockResolvedValue({ validated: true });
  jest.spyOn(Transaction, 'findOne').mockResolvedValue(freshTransaction());
  jest.spyOn(Transaction, 'findOneAndUpdate').mockImplementation(async (_filter, update) => ({
    _id: TRANSACTION_ID,
    status: update.$set.status,
  }));
  jest.spyOn(Vote, 'bulkWrite').mockResolvedValue({ modifiedCount: 1 });
  validateScriptSignatures.mockReset();
});

describe('multisig completeness gate (security)', () => {
  test('an { error } result from validateScriptSignatures is rejected, not treated as complete', async () => {
    validateScriptSignatures.mockResolvedValue({ error: 'Script not found' });
    const res = await putMultisig();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Vote.bulkWrite).not.toHaveBeenCalled();
  });

  test('a genuine incomplete multisig still records the transaction as pending', async () => {
    validateScriptSignatures.mockResolvedValue(false);
    const res = await putMultisig();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('info');
    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: TRANSACTION_ID },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'pending' }) }),
      expect.anything(),
    );
    expect(Vote.bulkWrite).not.toHaveBeenCalled();
  });

  test('a genuine complete multisig still submits votes', async () => {
    validateScriptSignatures.mockResolvedValue(true);
    const res = await putMultisig();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(Vote.bulkWrite).toHaveBeenCalled();
    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: TRANSACTION_ID },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'submitted' }) }),
      expect.anything(),
    );
  });
});
