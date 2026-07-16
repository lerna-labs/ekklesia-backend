import {
  normalizeWitness,
  keyHashFromPublicKeyHex,
  publicKeyFromCoseKey,
  signatureFromCoseSign1,
  CoseWitnessError,
} from '../helper/coseWitness.js';

// Real COSE bytes captured from a cardano-signer run against
// ~/ekklesia/docs/__tests/keys/drep01/drep.skey signing "hello".
const DREP01 = {
  coseSign1Hex:
    '84582aa201276761646472657373581d22db3b395fa83dc229be6fa122a6e887274d090ae7f20fa40657d98c69a166686173686564f44568656c6c6f5840' +
    // signature bytes — arbitrary for test, we're verifying extraction shape
    '11'.repeat(64),
  coseKeyHex:
    'a40101032720062158209d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8',
  expectedPublicKey: '9d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8',
  expectedKeyHash: 'db3b395fa83dc229be6fa122a6e887274d090ae7f20fa40657d98c69',
};

describe('coseWitness.normalizeWitness', () => {
  test('derives key, signature, publicKey from a CIP-30 minimal witness', () => {
    const w = normalizeWitness({
      coseSign1Hex: DREP01.coseSign1Hex,
      coseKeyHex: DREP01.coseKeyHex,
    });
    expect(w.coseSign1Hex).toBe(DREP01.coseSign1Hex);
    expect(w.coseKeyHex).toBe(DREP01.coseKeyHex);
    expect(w.publicKey).toBe(DREP01.expectedPublicKey);
    expect(w.key).toBe(DREP01.expectedKeyHash);
    expect(w.signature).toBe('11'.repeat(64));
  });

  test('preserves caller-provided fields (integrator sends full witness)', () => {
    const custom = 'deadbeef'.padEnd(64, '0');
    const w = normalizeWitness({
      coseSign1Hex: DREP01.coseSign1Hex,
      coseKeyHex: DREP01.coseKeyHex,
      key: custom,
      signature: 'cafe'.padEnd(128, '0'),
      publicKey: 'beef'.padEnd(64, '0'),
    });
    expect(w.key).toBe(custom);
    expect(w.signature).toBe('cafe'.padEnd(128, '0'));
    expect(w.publicKey).toBe('beef'.padEnd(64, '0'));
  });

  test('accepts keyHash alias (older integrator shape)', () => {
    const w = normalizeWitness({
      coseSign1Hex: DREP01.coseSign1Hex,
      coseKeyHex: DREP01.coseKeyHex,
      keyHash: 'AB'.repeat(28),
    });
    expect(w.key).toBe('ab'.repeat(28)); // lowercased
  });

  test('lowercases derived keyHash', () => {
    const w = normalizeWitness({
      coseSign1Hex: DREP01.coseSign1Hex,
      coseKeyHex: DREP01.coseKeyHex,
    });
    expect(w.key).toBe(w.key.toLowerCase());
  });

  test('throws on missing coseSign1Hex', () => {
    expect(() => normalizeWitness({ coseKeyHex: DREP01.coseKeyHex })).toThrow(CoseWitnessError);
  });

  test('throws on missing coseKeyHex', () => {
    expect(() => normalizeWitness({ coseSign1Hex: DREP01.coseSign1Hex })).toThrow(CoseWitnessError);
  });

  test('throws on garbage CBOR in coseKeyHex', () => {
    expect(() => normalizeWitness({ coseSign1Hex: DREP01.coseSign1Hex, coseKeyHex: 'zz' })).toThrow(
      CoseWitnessError,
    );
  });
});

describe('coseWitness.keyHashFromPublicKeyHex', () => {
  test('matches the drep01 fixture hash', () => {
    expect(keyHashFromPublicKeyHex(DREP01.expectedPublicKey)).toBe(DREP01.expectedKeyHash);
  });
});

describe('coseWitness.publicKeyFromCoseKey', () => {
  test('extracts the -2 field from a COSE key CBOR map', () => {
    expect(publicKeyFromCoseKey(DREP01.coseKeyHex)).toBe(DREP01.expectedPublicKey);
  });
});

describe('coseWitness.signatureFromCoseSign1', () => {
  test('extracts the 4th array element from COSE_Sign1', () => {
    expect(signatureFromCoseSign1(DREP01.coseSign1Hex)).toBe('11'.repeat(64));
  });
});
