import { ballotHasThreshold, computeThresholdReached } from '../results/voteThreshold.js';

const rows = (yes, no, abstain = 0) => ({
  results: [
    { id: 1, label: 'Yes', count: yes[0], votingPower: yes[1] },
    { id: -1, label: 'No', count: no[0], votingPower: no[1] },
    { id: 0, label: 'Abstain', count: abstain, votingPower: abstain * 1000 },
  ],
});
const ballot = (extra = {}) => ({
  source: 'legacy',
  voteWeighted: false,
  voteThreshold: 0.5,
  ...extra,
});

describe('computeThresholdReached', () => {
  test('above the threshold is true', () => {
    expect(computeThresholdReached(rows([6, 0], [4, 0]), ballot())).toBe(true);
  });

  test('exactly at the threshold is false', () => {
    expect(computeThresholdReached(rows([5, 0], [5, 0]), ballot())).toBe(false);
  });

  test('no Result is false', () => {
    expect(computeThresholdReached(null, ballot())).toBe(false);
  });

  test('yes + no of zero is false', () => {
    expect(computeThresholdReached(rows([0, 0], [0, 0], 7), ballot())).toBe(false);
  });

  test('unweighted ballots use count', () => {
    expect(computeThresholdReached(rows([6, 1], [4, 100]), ballot())).toBe(true);
  });

  test('weighted ballots use votingPower', () => {
    expect(computeThresholdReached(rows([6, 1], [4, 100]), ballot({ voteWeighted: true }))).toBe(
      false,
    );
  });

  test('abstain does not count toward the ratio', () => {
    expect(computeThresholdReached(rows([6, 0], [4, 0], 1000), ballot())).toBe(true);
  });

  test('numeric strings are converted', () => {
    const result = {
      results: [
        { id: '1', count: '7', votingPower: '0' },
        { id: '-1', count: '3', votingPower: '0' },
      ],
    };
    expect(computeThresholdReached(result, ballot())).toBe(true);
  });
});

describe('ballotHasThreshold', () => {
  test('legacy ballot with a numeric threshold qualifies', () => {
    expect(ballotHasThreshold(ballot())).toBe(true);
  });

  test('missing source counts as legacy', () => {
    expect(ballotHasThreshold({ voteThreshold: 0.6 })).toBe(true);
  });

  test('hydra ballots do not qualify', () => {
    expect(ballotHasThreshold(ballot({ source: 'hydra' }))).toBe(false);
  });

  test('null or absent threshold does not qualify', () => {
    expect(ballotHasThreshold(ballot({ voteThreshold: null }))).toBe(false);
    expect(ballotHasThreshold({ source: 'legacy' })).toBe(false);
  });
});
