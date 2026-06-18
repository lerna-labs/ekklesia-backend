// Witness verification: a COSE_Sign1 must sign THIS vote's merkleRoot and be a
// cryptographically valid Ed25519 signature. This is the primitive the audit
// found missing — the backend stored witnesses on key membership alone, so a
// cosigner signing the wrong message (historically the evidence voteHash) was
// accepted and submitted to Hydra.

import cbor from "cbor";
import { PrivateKey } from "@emurgo/cardano-serialization-lib-nodejs";
import {
  verifyWitnessAgainstMerkleRoot,
  coseSignatureValid,
  payloadFromCoseSign1,
  CoseWitnessError,
} from "../helper/coseWitness.js";

// Real, audited COSE vector (from helper/__tests__/verifySignature.test.js):
// a CIP-30 DRep key that genuinely signed the bytes of "abc123". Using it
// proves our Sig_structure reconstruction matches the shared verifySignature
// helper byte-for-byte, not just our own encoder.
const REAL = {
  coseSign1Hex:
    "845829a201276761646472657373581cdb3b395fa83dc229be6fa122a6e887274d090ae7f20fa40657d98c69a166686173686564f44661626331323358406fe4f7e5c587c6ec339c596bae4edba1f396b9645a6349388c331a90e98f9429a6279f610bf2e5615e15ed6c3e4659f97bf3f03480f0d2402287c60a4d2cc90f",
  coseKeyHex:
    "a40101032720062158209d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8",
  message: "abc123", // the UTF-8 string whose bytes were signed
};

const cborEncode = cbor.encode || cbor.default?.encode;

// Build a real witness over an arbitrary message, signed by a fresh Ed25519
// key. Mirrors what a CIP-30 wallet produces (hashed:false) so we can test
// witnesses over genuine 64-char merkleRoot strings, not just "abc123".
function makeWitness(messageStr, { tamper = false } = {}) {
  const priv = PrivateKey.generate_ed25519();
  const pub = priv.to_public();
  const pubBytes = Buffer.from(pub.as_bytes());
  const protectedHeader = cborEncode(new Map([[1, -8]])); // alg = EdDSA
  const payload = Buffer.from(messageStr, "utf8");
  const sigStruct = cborEncode(["Signature1", protectedHeader, Buffer.alloc(0), payload]);
  const ed = priv.sign(Uint8Array.from(sigStruct));
  let sigBytes = Buffer.from(ed.to_bytes());
  if (tamper) {
    sigBytes = Buffer.from(sigBytes);
    sigBytes[63] = sigBytes[63] ^ 0xff;
  }
  const coseSign1 = cborEncode([
    protectedHeader,
    new Map([["hashed", false]]),
    payload,
    sigBytes,
  ]);
  const coseKey = cborEncode(
    new Map([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, pubBytes],
    ])
  );
  return {
    coseSign1Hex: coseSign1.toString("hex"),
    coseKeyHex: coseKey.toString("hex"),
  };
}

describe("payloadFromCoseSign1", () => {
  test("extracts the signed payload bytes (element 3)", () => {
    expect(payloadFromCoseSign1(REAL.coseSign1Hex).toString("utf8")).toBe("abc123");
  });
});

describe("coseSignatureValid (Ed25519 over the COSE Sig_structure)", () => {
  test("validates the real audited vector", () => {
    expect(coseSignatureValid({ coseSign1Hex: REAL.coseSign1Hex, coseKeyHex: REAL.coseKeyHex })).toBe(
      true
    );
  });

  test("rejects a tampered signature", () => {
    const w = makeWitness("anything", { tamper: true });
    expect(coseSignatureValid(w)).toBe(false);
  });

  test("validates a freshly generated witness", () => {
    const w = makeWitness("hello world");
    expect(coseSignatureValid(w)).toBe(true);
  });
});

describe("verifyWitnessAgainstMerkleRoot", () => {
  test("accepts a witness that signs exactly the merkleRoot", () => {
    // Treat the real vector's signed string as the merkleRoot it covers.
    const res = verifyWitnessAgainstMerkleRoot(
      { coseSign1Hex: REAL.coseSign1Hex, coseKeyHex: REAL.coseKeyHex },
      REAL.message
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBeNull();
  });

  test("accepts a generated witness over a genuine 64-hex merkleRoot", () => {
    const merkleRoot = "a".repeat(64);
    const w = makeWitness(merkleRoot);
    expect(verifyWitnessAgainstMerkleRoot(w, merkleRoot).ok).toBe(true);
  });

  test("REGRESSION: rejects a witness that signed a DIFFERENT message (the bug)", () => {
    // The cosigner signed the evidence voteHash, not the merkleRoot.
    const merkleRoot = "a".repeat(64);
    const voteHash = "b".repeat(64);
    const w = makeWitness(voteHash); // signed the wrong thing
    const res = verifyWitnessAgainstMerkleRoot(w, merkleRoot);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/MESSAGE_MISMATCH/);
  });

  test("rejects a valid-message witness whose signature was tampered", () => {
    const merkleRoot = "c".repeat(64);
    const w = makeWitness(merkleRoot, { tamper: true });
    const res = verifyWitnessAgainstMerkleRoot(w, merkleRoot);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/SIGNATURE_INVALID/);
  });

  test("the real vector does NOT verify against an unrelated merkleRoot", () => {
    const res = verifyWitnessAgainstMerkleRoot(
      { coseSign1Hex: REAL.coseSign1Hex, coseKeyHex: REAL.coseKeyHex },
      "deadbeef".repeat(8)
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/MESSAGE_MISMATCH/);
  });

  test("throws on a missing merkleRoot argument", () => {
    const w = makeWitness("x");
    expect(() => verifyWitnessAgainstMerkleRoot(w, "")).toThrow(CoseWitnessError);
  });
});
