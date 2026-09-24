// Regression coverage for CodeQL alerts #11 and #12 (js/sql-injection).

import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const BALLOT_ID = new mongoose.Types.ObjectId();
const USER_ID = 'drep1testuser';
const VALID_PACKAGE_ID = new mongoose.Types.ObjectId().toString();

const liveHydraBallot = {
  _id: BALLOT_ID,
  source: 'hydra',
  votePeriodStart: new Date(Date.now() - 60_000),
  votePeriodEnd: new Date(Date.now() + 60_000),
};

await jest.unstable_mockModule('../../helper/verifyToken.js', () => ({
  verifyToken: () => ({ status: 'success', userId: USER_ID, signType: 'drep', multiSig: false }),
}));

await jest.unstable_mockModule('../../helper/idResolver.js', () => ({
  resolveBallot: async () => ({ doc: liveHydraBallot, source: 'internal' }),
  resolveProposal: async () => null,
}));

await jest.unstable_mockModule('../../helper/coseWitness.js', () => ({
  normalizeWitness: (w) => w,
  CoseWitnessError: class CoseWitnessError extends Error {},
  verifyWitnessAgainstMerkleRoot: () => ({ ok: true }),
}));

const { default: express } = await import('express');
const { VotePackage } = await import('../../schema/VotePackage.js');
const { default: votesRouter } = await import('../../routes/api/v1/votes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/votes', votesRouter);
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
  jest.spyOn(VotePackage, 'findOne').mockResolvedValue(null);
});

function postSignature(packageId) {
  return fetch(`${baseUrl}/votes/${BALLOT_ID.toString()}/signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      packageId,
      witness: { coseSign1Hex: 'ab', coseKeyHex: 'cd' },
    }),
  });
}

function postSubmit(packageId) {
  return fetch(`${baseUrl}/votes/${BALLOT_ID.toString()}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId }),
  });
}

describe('POST /:ballotId/signature packageId guard (alert #11)', () => {
  test('an operator object as packageId is rejected before reaching the database', async () => {
    const res = await postSignature({ $ne: null });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('BAD_INPUT');
    expect(VotePackage.findOne).not.toHaveBeenCalled();
  });

  test('a non-ObjectId string is rejected before reaching the database', async () => {
    const res = await postSignature('not-an-object-id');
    expect(res.status).toBe(400);
    expect(VotePackage.findOne).not.toHaveBeenCalled();
  });

  test('a valid 24-char ObjectId string reaches the database as an $eq-wrapped filter value', async () => {
    const res = await postSignature(VALID_PACKAGE_ID);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('PACKAGE_NOT_FOUND');
    expect(VotePackage.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $eq: VALID_PACKAGE_ID } }),
    );
  });
});

describe('POST /:ballotId/submit packageId guard (alert #12)', () => {
  test('an operator object as packageId is rejected before reaching the database', async () => {
    const res = await postSubmit({ $gt: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('BAD_INPUT');
    expect(VotePackage.findOne).not.toHaveBeenCalled();
  });

  test('a missing packageId is rejected before reaching the database', async () => {
    const res = await postSubmit(undefined);
    expect(res.status).toBe(400);
    expect(VotePackage.findOne).not.toHaveBeenCalled();
  });

  test('a valid 24-char ObjectId string reaches the database as an $eq-wrapped filter value', async () => {
    const res = await postSubmit(VALID_PACKAGE_ID);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('PACKAGE_NOT_FOUND');
    expect(VotePackage.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $eq: VALID_PACKAGE_ID } }),
    );
  });
});
