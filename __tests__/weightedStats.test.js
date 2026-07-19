import {
  computeWeightedStats,
  bucketWeightedVotesByGroup,
} from '../helper/results/weightedStats.js';

const proposal = {
  voterBudget: 100,
  voteOptions: [
    { id: 1, label: 'Protocol' },
    { id: 2, label: 'Ecosystem' },
    { id: 3, label: 'Ops' },
  ],
};

const voters = new Map([
  ['a', { voterGroup: 'drep', votingPower: 100 }],
  ['b', { voterGroup: 'drep', votingPower: 200 }],
  ['c', { voterGroup: 'pool', votingPower: 500 }],
]);

describe('weightedStats.computeWeightedStats', () => {
  test('returns null when proposal has no options', () => {
    expect(
      computeWeightedStats({
        proposal: { voterBudget: 100, voteOptions: [] },
        votes: [],
        votersByUserId: new Map(),
        voteWeighted: false,
      }),
    ).toBeNull();
  });

  test('mean is over answeringBallots (zero-filled), not non-zero contributors', () => {
    // Two voters, each allocating 100 points. Option 1: 50 + 40 = 90.
    // answeringBallots = 2, so mean = 90 / 2 = 45.
    const votes = [
      {
        userId: 'a',
        vote: [
          { option: 1, value: 50 },
          { option: 2, value: 30 },
          { option: 3, value: 20 },
        ],
      },
      {
        userId: 'b',
        vote: [
          { option: 1, value: 40 },
          { option: 2, value: 40 },
          { option: 3, value: 20 },
        ],
      },
    ];
    const r = computeWeightedStats({
      proposal,
      votes,
      votersByUserId: voters,
      voteWeighted: false,
    });
    expect(r.budget).toBe(100);
    expect(r.answeringBallots).toBe(2);
    const o1 = r.results.find((x) => x.option === 1);
    expect(o1.totalPoints).toBe(90);
    expect(o1.voterCount).toBe(2);
    expect(o1.mean).toBe(45);
    // stdDev over [50, 40]: mean 45 → variance = (25 + 25) / 2 = 25 → stdDev 5
    expect(o1.stdDev).toBeCloseTo(5);
  });

  test('voters who allocate 0 (or omit the option) contribute zero to mean denominator', () => {
    // Voter a puts all 100 on option 1. Voter b puts all 100 on option 2.
    // For option 1: totalPoints = 100, voterCount = 1 (value > 0),
    // answeringBallots = 2 → mean = 50.
    // Option 3: totalPoints = 0, voterCount = 0, mean = 0.
    const votes = [
      {
        userId: 'a',
        vote: [
          { option: 1, value: 100 },
          { option: 2, value: 0 },
          { option: 3, value: 0 },
        ],
      },
      {
        userId: 'b',
        vote: [
          { option: 1, value: 0 },
          { option: 2, value: 100 },
          { option: 3, value: 0 },
        ],
      },
    ];
    const r = computeWeightedStats({
      proposal,
      votes,
      votersByUserId: voters,
      voteWeighted: false,
    });
    const o1 = r.results.find((x) => x.option === 1);
    const o3 = r.results.find((x) => x.option === 3);
    expect(o1.totalPoints).toBe(100);
    expect(o1.voterCount).toBe(1);
    expect(o1.mean).toBe(50);
    // stdDev over [100, 0]: mean 50 → variance = (2500 + 2500) / 2 = 2500 → stdDev 50
    expect(o1.stdDev).toBeCloseTo(50);
    expect(o3.totalPoints).toBe(0);
    expect(o3.voterCount).toBe(0);
    expect(o3.mean).toBe(0);
    expect(o3.stdDev).toBe(0);
  });

  test("options omitted entirely from a voter's selection are treated as implicit zero", () => {
    // Voter a includes only options 1 and 2 (omits 3). Voter b includes all three.
    // Option 3: a=0 (implicit), b=20 → totalPoints=20, answeringBallots=2, mean=10.
    const votes = [
      {
        userId: 'a',
        vote: [
          { option: 1, value: 50 },
          { option: 2, value: 50 },
        ],
      },
      {
        userId: 'b',
        vote: [
          { option: 1, value: 40 },
          { option: 2, value: 40 },
          { option: 3, value: 20 },
        ],
      },
    ];
    const r = computeWeightedStats({
      proposal,
      votes,
      votersByUserId: voters,
      voteWeighted: false,
    });
    const o3 = r.results.find((x) => x.option === 3);
    expect(o3.totalPoints).toBe(20);
    expect(o3.voterCount).toBe(1);
    expect(o3.mean).toBe(10);
  });

  test('voteWeighted attaches powerTotalPoints and powerMean scaled by voter power', () => {
    const votes = [
      { userId: 'a', vote: [{ option: 1, value: 50 }] }, // power 100 → contrib 5000
      { userId: 'b', vote: [{ option: 1, value: 50 }] }, // power 200 → contrib 10000
    ];
    const r = computeWeightedStats({ proposal, votes, votersByUserId: voters, voteWeighted: true });
    const o1 = r.results.find((x) => x.option === 1);
    expect(o1.powerTotalPoints).toBe(15000);
    // Mean is over answeringBallots (2), matching Hydra semantics.
    expect(o1.powerMean).toBe(7500);
  });

  test('ignores malformed entries (non-object, negative, NaN)', () => {
    const votes = [
      {
        userId: 'a',
        vote: [
          { option: 1, value: 50 },
          { option: 2, value: -5 }, // rejected — treated as implicit zero
          null, // rejected
          { option: 3, value: Number.NaN }, // rejected — treated as implicit zero
        ],
      },
    ];
    const r = computeWeightedStats({
      proposal,
      votes,
      votersByUserId: voters,
      voteWeighted: false,
    });
    const o1 = r.results.find((x) => x.option === 1);
    const o2 = r.results.find((x) => x.option === 2);
    expect(o1.totalPoints).toBe(50);
    expect(o2.totalPoints).toBe(0);
  });
});

describe('weightedStats.bucketWeightedVotesByGroup', () => {
  test('groups votes by voterGroup, drops abstain', () => {
    const votes = [
      { userId: 'a', vote: [{ option: 1, value: 100 }] },
      { userId: 'b', vote: [{ option: 2, value: 100 }] },
      { userId: 'c', vote: ['abstain'] },
    ];
    const m = bucketWeightedVotesByGroup(votes, voters);
    expect(m.get('drep')).toHaveLength(2);
    expect(m.get('pool')).toBeUndefined();
  });
});
