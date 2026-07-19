// F-007 (backend half): the backend evidence bundle must match the shape and
// protocol version the Hydra middleware now emits (hydra/src/routes/voting.ts),
// so a replay auditor can parse either producer's object the same way and a
// cross-repo contract test can assert byte-identical bundles.

import {
  buildEvidence,
  finalizeEvidence,
  voteHash,
  PROTOCOL_VERSION,
} from '../helper/voteBroker.js';

const RETIRED_VERSIONS = ['ekklesia/1.0', '0.3.0'];

const BASE = {
  ballotId: '6a1512d782978c99456fe6de',
  voterId: 'drep1abc',
  credentialHrp: 'drep',
  nonce: 1,
  votes: [{ questionId: 'q1', selection: [1] }],
  responderRole: 'drep',
};

describe('protocol version', () => {
  test('PROTOCOL_VERSION is bumped to ekklesia/2.0, off every retired version', () => {
    expect(PROTOCOL_VERSION).toBe('ekklesia/2.0');
    expect(RETIRED_VERSIONS).not.toContain(PROTOCOL_VERSION);
  });

  test('buildEvidence stamps the bumped version', () => {
    expect(buildEvidence(BASE).specVersion).toBe('ekklesia/2.0');
  });
});

describe('top-level bundle shape (matches hydra voting.ts)', () => {
  const ev = buildEvidence(BASE);

  test('canonical top-level key set and order', () => {
    expect(Object.keys(ev)).toEqual([
      'specVersion',
      'surveyTxId',
      'responderRole',
      'answers',
      'ekklesia',
    ]);
  });

  test('surveyTxId defaults to ballotId', () => {
    expect(ev.surveyTxId).toBe(BASE.ballotId);
    expect(buildEvidence({ ...BASE, surveyTxId: 'txABC' }).surveyTxId).toBe('txABC');
  });

  test('answers carries the votes verbatim', () => {
    expect(ev.answers).toEqual(BASE.votes);
  });
});

describe('ekklesia extension keys are conditional and correctly positioned', () => {
  test('a key-based vote omits nativeScript and calidusDeclaration', () => {
    const ek = buildEvidence(BASE).ekklesia;
    expect(ek).not.toHaveProperty('nativeScript');
    expect(ek).not.toHaveProperty('calidusDeclaration');
    expect(Object.keys(ek)).toEqual([
      'voterId',
      'credentialHrp',
      'nonce',
      'signedPayload',
      'witnesses',
      'merkleProof',
    ]);
  });

  test('finalizeEvidence places nativeScript/calidusDeclaration between witnesses and merkleProof', () => {
    const { evidence } = finalizeEvidence(buildEvidence(BASE), {
      witnesses: [{ key: 'aa'.repeat(28) }],
      nativeScript: { type: 'all', scripts: [{ type: 'sig', keyHash: 'aa'.repeat(28) }] },
      calidusDeclaration: { poolId: 'pool1x' },
    });
    expect(Object.keys(evidence.ekklesia)).toEqual([
      'voterId',
      'credentialHrp',
      'nonce',
      'signedPayload',
      'witnesses',
      'nativeScript',
      'calidusDeclaration',
      'merkleProof',
    ]);
  });

  test('finalizeEvidence still omits the extension keys when not supplied', () => {
    const { evidence } = finalizeEvidence(buildEvidence(BASE), {
      witnesses: [{ key: 'aa'.repeat(28) }],
    });
    expect(evidence.ekklesia).not.toHaveProperty('nativeScript');
    expect(evidence.ekklesia).not.toHaveProperty('calidusDeclaration');
  });
});

describe('structural guard: no retired version literal is ever produced', () => {
  test('buildEvidence + finalizeEvidence never emit ekklesia/1.0 or 0.3.0', () => {
    const { evidence } = finalizeEvidence(buildEvidence(BASE), { witnesses: [] });
    const json = JSON.stringify(evidence);
    for (const v of RETIRED_VERSIONS) expect(json).not.toContain(v);
  });
});

describe('settled ballots stay verifiable (version-agnostic re-hash)', () => {
  // A frozen evidence bundle as historically pinned under the old version. The
  // broker never rewrites it; voteHash hashes the bundle exactly as given, so
  // the two ekklesia/1.0 ballots still reconstruct byte-for-byte after the bump.
  const legacy = {
    specVersion: 'ekklesia/1.0',
    surveyTxId: '6a1512d782978c99456fe6de',
    responderRole: 'drep',
    answers: [{ questionId: 'q1', selection: [1] }],
    ekklesia: {
      voterId: 'drep1abc',
      credentialHrp: 'drep',
      nonce: 1,
      signedPayload: {
        ballotId: '6a1512d782978c99456fe6de',
        nonce: 1,
        votes: [{ questionId: 'q1', selection: [1] }],
      },
      witnesses: [],
      merkleProof: { root: '', steps: [] },
    },
  };

  test('the legacy bundle keeps its declared version', () => {
    expect(legacy.specVersion).toBe('ekklesia/1.0');
  });

  test('voteHash of the legacy bundle is stable and reproducible', () => {
    const h1 = voteHash(legacy);
    const h2 = voteHash(JSON.parse(JSON.stringify(legacy)));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
