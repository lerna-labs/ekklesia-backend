// Unit test: tallyProposalProvisional leaves closed legacy ballots alone unless forced.

import { jest } from '@jest/globals';

const state = { ballot: null };
const updateOne = jest.fn();

const lean = (value) => ({ lean: async () => value });

await jest.unstable_mockModule('../schema/Question.js', () => ({
  Question: { findById: async () => ({ _id: 'p1', ballotId: 'b1', voteOptions: [] }) },
}));
await jest.unstable_mockModule('../schema/Ballot.js', () => ({
  Ballot: { findById: () => lean(state.ballot) },
}));
await jest.unstable_mockModule('../schema/Result.js', () => ({
  Result: { findOne: () => lean(null), updateOne },
}));
await jest.unstable_mockModule('../schema/Vote.js', () => ({
  Vote: { aggregate: async () => [], countDocuments: async () => 0 },
}));
await jest.unstable_mockModule('../schema/UserCache.js', () => ({ UserCache: {} }));
await jest.unstable_mockModule('../helper/hydraClient.js', () => ({
  forBallot: jest.fn(),
  HydraClientError: class extends Error {},
}));
await jest.unstable_mockModule('../helper/hydraEvidence.js', () => ({
  buildVotersByUserId: jest.fn(),
}));
await jest.unstable_mockModule('../helper/results/hydraTally.js', () => ({
  deriveProposalTally: jest.fn(),
}));
await jest.unstable_mockModule('../helper/results/ballotParticipation.js', () => ({
  computeBallotParticipation: async () => ({}),
  computeProposalParticipation: async () => ({ voterCount: {} }),
  computeParticipatingAbstainers: async () => ({}),
}));

const { tallyProposalProvisional } = await import('../crons/10minAggregateVotes.js');

beforeEach(() => {
  updateOne.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('tallyProposalProvisional on a closed legacy ballot', () => {
  test('skips and writes nothing', async () => {
    state.ballot = { _id: 'b1', source: 'legacy', status: 'closed' };
    expect(await tallyProposalProvisional('p1')).toBe('skipped');
    expect(updateOne).not.toHaveBeenCalled();
  });

  test('a missing source counts as legacy', async () => {
    state.ballot = { _id: 'b1', status: 'closed' };
    expect(await tallyProposalProvisional('p1')).toBe('skipped');
    expect(updateOne).not.toHaveBeenCalled();
  });

  test('runs with force', async () => {
    state.ballot = { _id: 'b1', source: 'legacy', status: 'closed' };
    expect(await tallyProposalProvisional('p1', { force: true })).toBe('updated');
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  test('open legacy ballots are still tallied', async () => {
    state.ballot = { _id: 'b1', source: 'legacy', status: 'live' };
    expect(await tallyProposalProvisional('p1')).toBe('updated');
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});
