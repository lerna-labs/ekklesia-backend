import {
  validatePayload,
  assertSnapshotCoverage,
  votersByUserIdFromSnapshot,
  CertifyError,
} from '../helper/results/certify.js';
import { deriveProposalTally } from '../helper/results/hydraTally.js';

// ---------------------------------------------------------------------------
// validatePayload
// ---------------------------------------------------------------------------

describe('validatePayload', () => {
  const ballotId = '69ea4289182d1ed6e1b3fa2b';

  test('rejects an empty payload', () => {
    expect(() => validatePayload({}, ballotId)).toThrow(CertifyError);
    expect(() => validatePayload(null, ballotId)).toThrow(/Missing certification/);
  });

  test('rejects snapshot.ballotId mismatch', () => {
    const payload = {
      snapshot: {
        ballotId: 'ffffffffffffffffffffffff',
        voters: [],
      },
    };
    expect(() => validatePayload(payload, ballotId)).toThrow(/does not match/);
  });

  test('rejects non-string votingPower (BigInt safety)', () => {
    const payload = {
      snapshot: {
        voters: [
          { voterId: 'drep1x', votingPower: 1234, eligible: true }, // number, not string
        ],
      },
    };
    expect(() => validatePayload(payload, ballotId)).toThrow(
      /votingPower must be a decimal string/,
    );
  });

  test('rejects non-boolean eligible', () => {
    const payload = {
      snapshot: {
        voters: [{ voterId: 'drep1x', votingPower: '1', eligible: 'yes' }],
      },
    };
    expect(() => validatePayload(payload, ballotId)).toThrow(/eligible must be a boolean/);
  });

  test('allows narrative-only (no snapshot)', () => {
    expect(() =>
      validatePayload({ narrative: { url: 'https://x', label: 'Result' } }, ballotId),
    ).not.toThrow();
  });

  test('narrative requires url + label', () => {
    expect(() => validatePayload({ narrative: { url: '' } }, ballotId)).toThrow(
      /narrative.url is required/,
    );
    expect(() => validatePayload({ narrative: { url: 'https://x' } }, ballotId)).toThrow(
      /narrative.label is required/,
    );
  });

  test('well-formed full payload passes', () => {
    const payload = {
      snapshot: {
        ballotId,
        voters: [
          { voterId: 'drep1x', votingPower: '1000', eligible: true },
          { voterId: 'pool1y', votingPower: '0', eligible: false },
        ],
      },
      narrative: { url: 'https://x', label: 'L' },
    };
    expect(() => validatePayload(payload, ballotId)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertSnapshotCoverage
// ---------------------------------------------------------------------------

describe('assertSnapshotCoverage', () => {
  function auditWith(voterIds, placeholderIds = []) {
    return {
      voters: [
        ...voterIds.map((id) => ({
          voterId: id,
          credentialHrp: 'drep',
          evidence: { answers: [] },
        })),
        ...placeholderIds.map((id) => ({ voterId: id, evidence: null })),
      ],
    };
  }

  test('passes when every evidence voter is in the snapshot', () => {
    expect(() =>
      assertSnapshotCoverage(
        {
          voters: [
            { voterId: 'drep1a', votingPower: '1', eligible: true },
            { voterId: 'drep1b', votingPower: '1', eligible: true },
          ],
        },
        auditWith(['drep1a', 'drep1b']),
      ),
    ).not.toThrow();
  });

  test('ignores pre-evidence placeholder rows (evidence === null)', () => {
    // stake1z has never voted; snapshot doesn't need to include it.
    expect(() =>
      assertSnapshotCoverage(
        { voters: [{ voterId: 'drep1a', votingPower: '1', eligible: true }] },
        auditWith(['drep1a'], ['stake1z']),
      ),
    ).not.toThrow();
  });

  test('rejects when an evidence voter is missing from the snapshot', () => {
    expect.assertions(3);
    try {
      assertSnapshotCoverage(
        { voters: [{ voterId: 'drep1a', votingPower: '1', eligible: true }] },
        auditWith(['drep1a', 'drep1b']),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CertifyError);
      expect(err.code).toBe('SNAPSHOT_COVERAGE_INCOMPLETE');
      expect(err.details.missingVoterIds).toEqual(['drep1b']);
    }
  });

  test("tolerates extra voters in the snapshot that aren't in evidence", () => {
    // Authority may include "eligible voters who didn't vote" — ignored,
    // not rejected.
    expect(() =>
      assertSnapshotCoverage(
        {
          voters: [
            { voterId: 'drep1a', votingPower: '1', eligible: true },
            { voterId: 'pool1_unvoted', votingPower: '99', eligible: true },
          ],
        },
        auditWith(['drep1a']),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// votersByUserIdFromSnapshot
// ---------------------------------------------------------------------------

describe('votersByUserIdFromSnapshot', () => {
  function audit(voters) {
    return {
      voters: voters.map(([id, hrp]) => ({
        voterId: id,
        credentialHrp: hrp,
        evidence: { answers: [] },
      })),
    };
  }

  test('maps HRP to voterGroup via hydra evidence', () => {
    const auditFull = audit([
      ['drep1a', 'drep'],
      ['pool1b', 'pool'],
      ['calidus1c', 'calidus'],
      ['stake_test1d', 'stake_test'],
    ]);
    const snapshot = [
      { voterId: 'drep1a', votingPower: '1000', eligible: true },
      { voterId: 'pool1b', votingPower: '2000', eligible: true },
      { voterId: 'calidus1c', votingPower: '3000', eligible: true },
      { voterId: 'stake_test1d', votingPower: '4000', eligible: true },
    ];
    const map = votersByUserIdFromSnapshot(snapshot, auditFull);
    expect(map.get('drep1a').voterGroup).toBe('drep');
    expect(map.get('pool1b').voterGroup).toBe('pool');
    expect(map.get('calidus1c').voterGroup).toBe('pool'); // calidus → pool
    expect(map.get('stake_test1d').voterGroup).toBe('stake');
  });

  test('omits ineligible voters entirely', () => {
    const auditFull = audit([
      ['drep1a', 'drep'],
      ['drep1b', 'drep'],
    ]);
    const snapshot = [
      { voterId: 'drep1a', votingPower: '500', eligible: true },
      { voterId: 'drep1b', votingPower: '999', eligible: false },
    ];
    const map = votersByUserIdFromSnapshot(snapshot, auditFull);
    expect(map.has('drep1a')).toBe(true);
    expect(map.has('drep1b')).toBe(false);
  });

  test('converts votingPower string to number', () => {
    const auditFull = audit([['drep1a', 'drep']]);
    const snapshot = [{ voterId: 'drep1a', votingPower: '1234567890', eligible: true }];
    const map = votersByUserIdFromSnapshot(snapshot, auditFull);
    expect(map.get('drep1a').votingPower).toBe(1234567890);
  });
});

// ---------------------------------------------------------------------------
// Integration spot-check: authority snapshot power differs from Hydra's
// raw count → derived tally reflects the authority's numbers.
// ---------------------------------------------------------------------------

describe('deriveProposalTally via authority snapshot', () => {
  const ballotId = '69ea4289182d1ed6e1b3fa2b';
  const proposal = {
    _id: 'q1',
    voteType: 'choice',
    voteOptions: [
      { id: 1, label: 'Yes' },
      { id: 2, label: 'No' },
    ],
    requireAnswer: true,
  };
  const ballot = { voteWeighted: false };
  const auditFull = {
    voters: [
      {
        voterId: 'drep1a',
        credentialHrp: 'drep',
        evidence: {
          specVersion: 'ekklesia/1.0',
          responderRole: 'drep',
          answers: [{ questionId: 'q1', selection: [1] }],
        },
      },
      {
        voterId: 'drep1b',
        credentialHrp: 'drep',
        evidence: {
          specVersion: 'ekklesia/1.0',
          responderRole: 'drep',
          answers: [{ questionId: 'q1', selection: [1] }],
        },
      },
    ],
  };

  test('votingPower in output comes from snapshot, not UserCache', () => {
    // Authority says drep1a had power 9999; drep1b had power 1.
    const snapshot = [
      { voterId: 'drep1a', votingPower: '9999', eligible: true },
      { voterId: 'drep1b', votingPower: '1', eligible: true },
    ];
    const votersByUserId = votersByUserIdFromSnapshot(snapshot, auditFull);
    const { results, resultsByGroup, proposalParticipation } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    const yes = results.find((r) => r.id === 1);
    expect(yes.count).toBe(2);
    expect(yes.votingPower).toBe(10000); // 9999 + 1
    expect(resultsByGroup.drep.results.find((r) => r.id === 1).votingPower).toBe(10000);
    expect(proposalParticipation.voterCount.drep).toBe(2);
    expect(proposalParticipation.totalVotingPower.drep).toBe(10000);
  });

  test('ineligible voter drops out of the tally entirely', () => {
    // Authority excludes drep1b. Only drep1a's vote counts.
    const snapshot = [
      { voterId: 'drep1a', votingPower: '100', eligible: true },
      { voterId: 'drep1b', votingPower: '200', eligible: false },
    ];
    const votersByUserId = votersByUserIdFromSnapshot(snapshot, auditFull);
    const { results, proposalParticipation } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    const yes = results.find((r) => r.id === 1);
    expect(yes.count).toBe(1);
    expect(yes.votingPower).toBe(100);
    expect(proposalParticipation.voterCount.drep).toBe(1);
  });
});
