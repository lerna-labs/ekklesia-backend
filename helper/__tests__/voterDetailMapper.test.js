import { projectVoteEntries } from '../voterDetailMapper.js';

const choiceProposal = {
  voteType: 'choice',
  voteOptions: [
    { id: 'opt-yes', label: 'Yes' },
    { id: 'opt-no', label: 'No' },
  ],
};

const multiChoiceProposal = {
  voteType: 'multi-choice',
  voteOptions: [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
  ],
};

const rankedProposal = {
  voteType: 'ranked',
  voteOptions: [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
  ],
};

const scaleProposal = {
  voteType: 'scale',
  voteOptions: [],
};

const likertProposal = {
  voteType: 'likert',
  voteOptions: [
    { id: 'stmt-1', label: 'Onboarding is clear' },
    { id: 'stmt-2', label: 'Docs are sufficient' },
  ],
};

const weightedProposal = {
  voteType: 'weighted',
  voteOptions: [
    { id: 'fund-a', label: 'Fund A' },
    { id: 'fund-b', label: 'Fund B' },
    { id: 'fund-c', label: 'Fund C' },
  ],
};

describe('projectVoteEntries', () => {
  test('choice → label array', () => {
    expect(projectVoteEntries(['opt-yes'], choiceProposal)).toEqual(['Yes']);
  });

  test('multi-choice → multiple labels, drops unknown ids', () => {
    expect(projectVoteEntries(['alice', 'carol', 'ghost'], multiChoiceProposal)).toEqual([
      'Alice',
      'Carol',
    ]);
  });

  test('ranked → ordered labels', () => {
    expect(projectVoteEntries(['bob', 'alice', 'carol'], rankedProposal)).toEqual([
      'Bob',
      'Alice',
      'Carol',
    ]);
  });

  test('scale → numeric value preserved', () => {
    expect(projectVoteEntries([42], scaleProposal)).toEqual([42]);
  });

  test('scale 0 is preserved (not stripped by Boolean filter)', () => {
    expect(projectVoteEntries([0], scaleProposal)).toEqual([0]);
  });

  test("abstain sentinel → ['Abstain']", () => {
    expect(projectVoteEntries(['abstain'], choiceProposal)).toEqual(['Abstain']);
    expect(projectVoteEntries(['abstain'], likertProposal)).toEqual(['Abstain']);
    expect(projectVoteEntries(['abstain'], weightedProposal)).toEqual(['Abstain']);
  });

  test('likert → object entries with denormalized optionLabel', () => {
    const submitted = [
      { option: 'stmt-1', value: 4 },
      { option: 'stmt-2', value: 2 },
    ];
    expect(projectVoteEntries(submitted, likertProposal)).toEqual([
      { option: 'stmt-1', optionLabel: 'Onboarding is clear', value: 4 },
      { option: 'stmt-2', optionLabel: 'Docs are sufficient', value: 2 },
    ]);
  });

  test('weighted → object entries, integer values preserved', () => {
    const submitted = [
      { option: 'fund-a', value: 25 },
      { option: 'fund-b', value: 50 },
      { option: 'fund-c', value: 25 },
    ];
    const out = projectVoteEntries(submitted, weightedProposal);
    expect(out).toEqual([
      { option: 'fund-a', optionLabel: 'Fund A', value: 25 },
      { option: 'fund-b', optionLabel: 'Fund B', value: 50 },
      { option: 'fund-c', optionLabel: 'Fund C', value: 25 },
    ]);
    expect(out.reduce((s, e) => s + e.value, 0)).toBe(100);
  });

  test('likert with unknown option falls back to id as label', () => {
    expect(projectVoteEntries([{ option: 'phantom', value: 3 }], likertProposal)).toEqual([
      { option: 'phantom', optionLabel: 'phantom', value: 3 },
    ]);
  });

  test('non-array submittedVote → []', () => {
    expect(projectVoteEntries(undefined, choiceProposal)).toEqual([]);
    expect(projectVoteEntries(null, choiceProposal)).toEqual([]);
  });

  test('ObjectId-like ids compared by toString', () => {
    const idA = { toString: () => 'stmt-1' };
    const idB = { toString: () => 'stmt-1' };
    expect(
      projectVoteEntries([{ option: idA, value: 5 }], {
        voteType: 'likert',
        voteOptions: [{ id: idB, label: 'Onboarding is clear' }],
      }),
    ).toEqual([{ option: idA, optionLabel: 'Onboarding is clear', value: 5 }]);
  });
});
