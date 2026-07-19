import {
  voteFromAnswer,
  votesForProposal,
  voterIdsIn,
  voterGroupFromHrp,
  buildVotersByUserId,
} from '../helper/hydraEvidence.js';

const fakeAudit = {
  ballot: { id: 'b1' },
  totalVoters: 3,
  voters: [
    {
      voterId: 'drep1xxx',
      credentialHrp: 'drep',
      evidence: {
        specVersion: 'ekklesia/1.0',
        responderRole: 'drep',
        answers: [
          { questionId: 'q1', selection: [1] },
          { questionId: 'q2', abstain: true },
          { questionId: 'q3', selection: [{ option: 1, value: 5 }] },
        ],
      },
    },
    {
      voterId: 'pool1yyy',
      credentialHrp: 'pool',
      evidence: {
        specVersion: 'ekklesia/1.0',
        responderRole: 'pool',
        answers: [
          { questionId: 'q1', selection: [2] },
          {
            questionId: 'q3',
            selection: [
              { option: 1, value: 3 },
              { option: 2, value: 2 },
            ],
          },
        ],
      },
    },
    {
      // Pre-finalize placeholder — no evidence yet. Must be skipped.
      voterId: 'stake1zzz',
      credentialHrp: 'stake',
      evidence: null,
    },
  ],
};

describe('voteFromAnswer', () => {
  test("abstain becomes ['abstain']", () => {
    expect(voteFromAnswer({ questionId: 'q', abstain: true })).toEqual(['abstain']);
  });
  test('numeric selection passes through', () => {
    expect(voteFromAnswer({ questionId: 'q', selection: [1, 2, 3] })).toEqual([1, 2, 3]);
  });
  test('selection-entry pairs pass through', () => {
    expect(voteFromAnswer({ questionId: 'q', selection: [{ option: 1, value: 5 }] })).toEqual([
      { option: 1, value: 5 },
    ]);
  });
  test('missing selection + no abstain → null', () => {
    expect(voteFromAnswer({ questionId: 'q' })).toBeNull();
    expect(voteFromAnswer(null)).toBeNull();
    expect(voteFromAnswer(undefined)).toBeNull();
  });
});

describe('votesForProposal', () => {
  test('extracts drep + pool for q1, skips no-evidence voter', () => {
    const rows = votesForProposal(fakeAudit, 'q1');
    expect(rows).toEqual([
      { userId: 'drep1xxx', vote: [1] },
      { userId: 'pool1yyy', vote: [2] },
    ]);
  });
  test("abstain represented as ['abstain']", () => {
    const rows = votesForProposal(fakeAudit, 'q2');
    expect(rows).toEqual([{ userId: 'drep1xxx', vote: ['abstain'] }]);
  });
  test('selection-entry shape preserved for weighted/likert', () => {
    const rows = votesForProposal(fakeAudit, 'q3');
    expect(rows).toEqual([
      { userId: 'drep1xxx', vote: [{ option: 1, value: 5 }] },
      {
        userId: 'pool1yyy',
        vote: [
          { option: 1, value: 3 },
          { option: 2, value: 2 },
        ],
      },
    ]);
  });
  test('unknown questionId returns empty list', () => {
    expect(votesForProposal(fakeAudit, 'nope')).toEqual([]);
  });
  test('empty bundle → empty list', () => {
    expect(votesForProposal({}, 'q1')).toEqual([]);
    expect(votesForProposal(null, 'q1')).toEqual([]);
  });
});

describe('voterIdsIn', () => {
  test('returns non-null voter ids in order', () => {
    expect(voterIdsIn(fakeAudit)).toEqual(['drep1xxx', 'pool1yyy', 'stake1zzz']);
  });
});

describe('voterGroupFromHrp', () => {
  test('maps drep', () => {
    expect(voterGroupFromHrp('drep')).toBe('drep');
  });
  test('maps pool + calidus both to pool', () => {
    expect(voterGroupFromHrp('pool')).toBe('pool');
    expect(voterGroupFromHrp('calidus')).toBe('pool');
  });
  test('maps stake and stake_test to stake', () => {
    expect(voterGroupFromHrp('stake')).toBe('stake');
    expect(voterGroupFromHrp('stake_test')).toBe('stake');
  });
  test('upper-case coerced', () => {
    expect(voterGroupFromHrp('DREP')).toBe('drep');
  });
  test('unknown → default', () => {
    expect(voterGroupFromHrp('weirdo')).toBe('default');
    expect(voterGroupFromHrp(null)).toBe('default');
    expect(voterGroupFromHrp(undefined)).toBe('default');
  });
});

describe('buildVotersByUserId', () => {
  test('prefers UserCache rows, falls back to HRP + power=1', async () => {
    const cached = [
      { userId: 'drep1xxx', voterGroup: 'drep', votingPower: 42 },
      // pool1yyy has no UserCache row — fall back path
      // stake1zzz has evidence=null but appears in the voter list; build an
      // entry anyway so callers never NPE on a bundle voter reference.
    ];
    const UserCacheMock = {
      find: () => ({
        select: () => ({ lean: async () => cached }),
      }),
    };
    const map = await buildVotersByUserId(fakeAudit, 'bal1', UserCacheMock);
    expect(map.get('drep1xxx')).toEqual({
      userId: 'drep1xxx',
      voterGroup: 'drep',
      votingPower: 42,
    });
    expect(map.get('pool1yyy')).toEqual({
      userId: 'pool1yyy',
      voterGroup: 'pool',
      votingPower: 1,
    });
    expect(map.get('stake1zzz')).toEqual({
      userId: 'stake1zzz',
      voterGroup: 'stake',
      votingPower: 1,
    });
  });
  test('empty bundle short-circuits without hitting the DB', async () => {
    let findCalls = 0;
    const UserCacheMock = {
      find: () => {
        findCalls += 1;
        return { select: () => ({ lean: async () => [] }) };
      },
    };
    const map = await buildVotersByUserId({ voters: [] }, 'bal1', UserCacheMock);
    expect(map.size).toBe(0);
    expect(findCalls).toBe(0);
  });
});
