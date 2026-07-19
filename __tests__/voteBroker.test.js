import { canonicalize } from '../helper/canonicalJson.js';
import {
  buildSigningPayload,
  buildEvidence,
  voteHash,
  finalizeEvidence,
} from '../helper/voteBroker.js';

describe('canonicalJson', () => {
  test('sorts keys deterministically', () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  test('skips undefined values', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('handles arrays in order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('voteBroker payload', () => {
  test('buildSigningPayload returns canonical shape', () => {
    const p = buildSigningPayload({
      ballotId: 'ballot-1',
      nonce: 2,
      votes: [{ questionId: 'q1', selection: [1] }],
    });
    expect(p).toEqual({
      ballotId: 'ballot-1',
      nonce: 2,
      votes: [{ questionId: 'q1', selection: [1] }],
    });
  });

  test('voteHash is deterministic for equivalent evidence', () => {
    const a = buildEvidence({
      ballotId: 'b',
      voterId: 'drep1xyz',
      credentialHrp: 'drep',
      nonce: 1,
      votes: [{ questionId: 'q', selection: [1] }],
    });
    const b = buildEvidence({
      ballotId: 'b',
      voterId: 'drep1xyz',
      credentialHrp: 'drep',
      nonce: 1,
      votes: [{ questionId: 'q', selection: [1] }],
    });
    expect(voteHash(a)).toBe(voteHash(b));
    expect(voteHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('finalizeEvidence updates hash when witnesses change', () => {
    const base = buildEvidence({
      ballotId: 'b',
      voterId: 'drep1xyz',
      credentialHrp: 'drep',
      nonce: 1,
      votes: [{ questionId: 'q', selection: [1] }],
    });
    const preHash = voteHash(base);
    const { evidence, voteHash: postHash } = finalizeEvidence(base, {
      witnesses: [
        { key: 'aa'.repeat(28), coseSign1Hex: 'deadbeef', coseKeyHex: '', signature: '' },
      ],
    });
    expect(evidence.ekklesia.witnesses).toHaveLength(1);
    expect(postHash).not.toBe(preHash);
  });
});
