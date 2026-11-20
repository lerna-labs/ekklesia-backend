// Unit test: repairLegacyBallots plans and applies the pre-rename legacy ballot repair.

import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const oid = () => new mongoose.Types.ObjectId();
const ballotId = oid();
const proposalId = oid();
const PAST = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-06-01T00:00:00Z');

const db = {};
const reset = () => {
  db.ballot = { _id: ballotId, votePeriodEnd: PAST, voterValidationScript: 'gone.js' };
  db.votes = 0;
  db.votercaches = [];
  db.usercaches = [];
  db.comments = [];
};

const tally = jest.fn(async () => 'updated');
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => (v === null ? doc[k] == null : doc[k] === v));

await jest.unstable_mockModule('../schema/Ballot.js', () => ({
  Ballot: {
    collection: { findOne: async () => (db.ballot ? { ...db.ballot } : null) },
    updateOne: async (_f, { $set }) => Object.assign(db.ballot, $set),
  },
}));
await jest.unstable_mockModule('../schema/Question.js', () => ({
  Question: { find: () => ({ select: () => ({ lean: async () => [{ _id: proposalId }] }) }) },
}));
await jest.unstable_mockModule('../schema/Vote.js', () => ({
  Vote: { collection: { countDocuments: async () => db.votes } },
}));
await jest.unstable_mockModule('../schema/Comment.js', () => ({
  Comment: {
    collection: {
      find: (f) => ({
        toArray: async () => db.comments.filter((c) => matches(c, { userId: f.userId })),
      }),
      updateOne: async ({ _id }, { $set }) =>
        Object.assign(
          db.comments.find((c) => c._id === _id),
          $set,
        ),
    },
  },
}));
await jest.unstable_mockModule('../schema/UserCache.js', () => ({
  UserCache: {
    db: { collection: () => ({ find: () => ({ toArray: async () => db.votercaches }) }) },
    find: () => ({ lean: async () => db.usercaches }),
    insertMany: async (rows) => db.usercaches.push(...rows),
  },
}));
await jest.unstable_mockModule('../schema/Result.js', () => ({
  Result: { findOne: () => ({ lean: async () => null }) },
}));
await jest.unstable_mockModule('../crons/10minAggregateVotes.js', () => ({
  tallyProposalProvisional: tally,
}));
await jest.unstable_mockModule('../__scripts/scaffold/common/env.js', () => ({
  bootstrap: jest.fn(),
  teardown: jest.fn(),
}));

const { parseBallotArgs, planBallotChanges, planUserCacheCopy, repairLegacyBallots } =
  await import('../__scripts/repairLegacyBallots.js');

beforeEach(() => {
  reset();
  tally.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const run = (opts = {}) => repairLegacyBallots([String(ballotId)], { now: NOW, ...opts });

describe('helpers', () => {
  test('repeatable --ballot and --apply', () => {
    expect(parseBallotArgs(['--ballot', 'a', '--ballot=b', '--apply'])).toEqual({
      ballotIds: ['a', 'b'],
      apply: true,
    });
    expect(parseBallotArgs(['--ballot', 'a'])).toEqual({ ballotIds: ['a'], apply: false });
  });

  test('ballot changes list only differing fields', () => {
    const done = {
      source: 'legacy',
      status: 'closed',
      voterValidationScript: 'voterValidationAlwaysFalse.js',
    };
    expect(planBallotChanges(done)).toEqual({});
    expect(Object.keys(planBallotChanges({ voterValidationScript: 'x.js' }))).toEqual([
      'source',
      'status',
      'voterValidationScript',
    ]);
  });

  test('copy plan skips existing rows, reports differences, prefixes and duplicates', () => {
    const rows = [
      { voterId: 'drep1a', ballotId, validated: true, votingPower: 5 },
      { voterId: 'stake1b', ballotId, validated: true, votingPower: 7 },
      { voterId: 'pool1c', ballotId, validated: true, votingPower: 9 },
      { voterId: 'stake_test1e', ballotId, validated: true, votingPower: 3 },
      { voterId: 'addr1d', ballotId, validated: true, votingPower: 1 },
      { voterId: 'drep1a', ballotId, validated: true, votingPower: 5 },
    ];
    const existing = new Map([
      ['stake1b', { validated: true, votingPower: 7, voterGroup: 'stake' }],
      ['pool1c', { validated: true, votingPower: 1, voterGroup: 'pool' }],
    ]);
    const plan = planUserCacheCopy(rows, existing);
    expect(plan.insert.map((r) => [r.userId, r.voterGroup])).toEqual([
      ['drep1a', 'drep'],
      ['stake_test1e', 'stake'],
    ]);
    expect(plan.same).toEqual(['stake1b']);
    expect(plan.differ.map((d) => d.userId)).toEqual(['pool1c']);
    expect(plan.badPrefix).toEqual(['addr1d']);
    expect(plan.duplicate).toEqual(['drep1a']);
  });
});

describe('repairLegacyBallots', () => {
  const seed = () => {
    db.votercaches = [
      { voterId: 'drep1a', ballotId, validated: true, votingPower: 5 },
      { voterId: 'addr1x', ballotId, validated: true, votingPower: 2 },
    ];
    db.comments = [{ _id: 'c1', voterId: 'drep1a', proposalId }];
  };

  test.each([
    ['a missing ballot', () => (db.ballot = null)],
    ['a hydra ballot', () => (db.ballot.source = 'hydra')],
    ['an unfinished ballot', () => (db.ballot.votePeriodEnd = new Date('2027-01-01'))],
    ['votes without userId', () => (db.votes = 3)],
  ])('refuses %s and writes nothing', async (_name, mutate) => {
    seed();
    mutate();
    const before = JSON.stringify([db.ballot, db.usercaches, db.comments]);
    const out = await run({ apply: true });
    expect(out.refused).toBe(true);
    expect(JSON.stringify([db.ballot, db.usercaches, db.comments])).toBe(before);
    expect(tally).not.toHaveBeenCalled();
  });

  test('a stored null source counts as legacy', async () => {
    seed();
    db.ballot.source = null;
    const out = await run({ apply: true });
    expect(out.refused).toBe(false);
    expect(db.ballot.source).toBe('legacy');
  });

  test('dry run writes nothing and does not recount', async () => {
    seed();
    const before = JSON.stringify([db.ballot, db.usercaches, db.comments]);
    const out = await run();
    expect(out.changed).toBe(3);
    expect(JSON.stringify([db.ballot, db.usercaches, db.comments])).toBe(before);
    expect(tally).not.toHaveBeenCalled();
  });

  test('apply repairs the ballot, usercaches and comments, then recounts with force', async () => {
    seed();
    await run({ apply: true });
    expect(db.ballot).toMatchObject({
      source: 'legacy',
      status: 'closed',
      voterValidationScript: 'voterValidationAlwaysFalse.js',
    });
    expect(db.usercaches).toEqual([
      { userId: 'drep1a', ballotId, validated: true, votingPower: 5, voterGroup: 'drep' },
    ]);
    expect(db.comments[0]).toMatchObject({ userId: 'drep1a', status: 'live' });
    expect(tally).toHaveBeenCalledWith(proposalId, expect.objectContaining({ force: true }));
  });

  test('a second apply changes nothing', async () => {
    seed();
    await run({ apply: true });
    const snapshot = JSON.stringify([db.ballot, db.usercaches, db.comments]);
    const out = await run({ apply: true });
    expect(out.changed).toBe(0);
    expect(JSON.stringify([db.ballot, db.usercaches, db.comments])).toBe(snapshot);
  });
});
