import { computeRankedDistribution } from '../helper/results/rankedDistribution.js';

const proposal = {
  voteOptions: [
    { id: 1, label: 'Alice' },
    { id: 2, label: 'Bob' },
    { id: 3, label: 'Carol' },
    { id: 4, label: 'Dave' },
  ],
};

const voters = new Map([
  ['a', { voterGroup: 'drep', votingPower: 100 }],
  ['b', { voterGroup: 'drep', votingPower: 200 }],
  ['c', { voterGroup: 'pool', votingPower: 5000 }],
]);

describe('rankedDistribution.computeRankedDistribution', () => {
  test('counts ranks per option per group', () => {
    const result = computeRankedDistribution({
      proposal,
      votes: [
        { userId: 'a', vote: [1, 2, 3] }, // Alice 1st, Bob 2nd, Carol 3rd; Dave unranked
        { userId: 'b', vote: [2, 1, 4, 3] }, // Bob 1st, Alice 2nd, Dave 3rd, Carol 4th
        { userId: 'c', vote: [3, 4] }, // Carol 1st, Dave 2nd
      ],
      votersByUserId: voters,
    });
    const drep = result.get('drep');
    expect(drep.rankDepth).toBe(4);
    const alice = drep.rows.find((r) => r.id === 1);
    expect(alice.counts).toEqual([1, 1, 0, 0]);
    expect(alice.power).toEqual([100, 200, 0, 0]);
    expect(alice.unranked).toEqual({ count: 0, power: 0 });
    const dave = drep.rows.find((r) => r.id === 4);
    expect(dave.counts).toEqual([0, 0, 1, 0]);
    expect(dave.unranked).toEqual({ count: 1, power: 100 });
    const pool = result.get('pool');
    const carol = pool.rows.find((r) => r.id === 3);
    expect(carol.counts).toEqual([1, 0, 0, 0]);
    expect(carol.power).toEqual([5000, 0, 0, 0]);
  });

  test("abstain-only votes don't contribute", () => {
    const result = computeRankedDistribution({
      proposal,
      votes: [{ userId: 'a', vote: ['abstain'] }],
      votersByUserId: voters,
    });
    expect(result.size).toBe(0);
  });

  test('partial rankings populate unranked bucket', () => {
    const result = computeRankedDistribution({
      proposal,
      votes: [{ userId: 'a', vote: [1] }],
      votersByUserId: voters,
    });
    const drep = result.get('drep');
    const alice = drep.rows.find((r) => r.id === 1);
    expect(alice.counts).toEqual([1, 0, 0, 0]);
    const bob = drep.rows.find((r) => r.id === 2);
    expect(bob.unranked).toEqual({ count: 1, power: 100 });
  });
});
