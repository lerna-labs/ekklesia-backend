// The backend must only ever submit a VALID multisig package to Hydra:
// every stored witness signs the package's own merkleRoot (not the evidence
// voteHash), and the cosigner view serves that same merkleRoot. These tests
// pin the invariant end to end, offline.

import cbor from "cbor";
import { PrivateKey } from "@emurgo/cardano-serialization-lib-nodejs";
import { buildEvidence, voteHash, merkleRootHex } from "../helper/voteBroker.js";
import { normalizeWitness } from "../helper/coseWitness.js";
import {
  enrichPackageView,
  assertValidPackage,
  PackageInvariantError,
} from "../routes/api/v1/votes.js";

const cborEncode = cbor.encode || cbor.default?.encode;

function makeWitness(messageStr, { tamper = false } = {}) {
  const priv = PrivateKey.generate_ed25519();
  const pubBytes = Buffer.from(priv.to_public().as_bytes());
  const protectedHeader = cborEncode(new Map([[1, -8]]));
  const payload = Buffer.from(messageStr, "utf8");
  const sigStruct = cborEncode(["Signature1", protectedHeader, Buffer.alloc(0), payload]);
  let sigBytes = Buffer.from(priv.sign(Uint8Array.from(sigStruct)).to_bytes());
  if (tamper) {
    sigBytes = Buffer.from(sigBytes);
    sigBytes[63] ^= 0xff;
  }
  const coseSign1 = cborEncode([protectedHeader, new Map([["hashed", false]]), payload, sigBytes]);
  const coseKey = cborEncode(
    new Map([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, pubBytes],
    ])
  );
  return normalizeWitness({
    coseSign1Hex: coseSign1.toString("hex"),
    coseKeyHex: coseKey.toString("hex"),
  });
}

const VOTES = [{ questionId: "q1", selection: [1] }];
const evidence = buildEvidence({
  ballotId: "6a1512d782978c99456fe6de",
  voterId: "drep1abc",
  credentialHrp: "drep",
  nonce: 1,
  votes: VOTES,
});
const signingPayload = evidence.ekklesia.signedPayload;
const MERKLE_ROOT = merkleRootHex(signingPayload);
const VOTE_HASH = voteHash(evidence);

describe("hash separation", () => {
  test("the evidence voteHash and the signing-payload merkleRoot are never equal", () => {
    expect(VOTE_HASH).not.toBe(MERKLE_ROOT);
    expect(MERKLE_ROOT).toMatch(/^[0-9a-f]{64}$/);
    expect(VOTE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("enrichPackageView", () => {
  test("derives merkleRoot from signingPayload, NEVER from pkg.voteHash", () => {
    const pkg = {
      _id: { toString: () => "p1" },
      signingPayload,
      // a stored voteHash that differs from the merkleRoot — the historical bug
      // served THIS value as the signing target.
      voteHash: VOTE_HASH,
    };
    const view = enrichPackageView(pkg);
    expect(view.merkleRoot).toBe(MERKLE_ROOT);
    expect(view.merkleRoot).not.toBe(pkg.voteHash);
    // signingPayloadHex is the utf8-hex of the merkleRoot the voter signs.
    expect(view.signingPayloadHex).toBe(Buffer.from(MERKLE_ROOT, "utf8").toString("hex"));
  });

  test("returns null merkleRoot when there is no signingPayload", () => {
    const view = enrichPackageView({ voteHash: VOTE_HASH });
    expect(view.merkleRoot).toBeNull();
  });
});

describe("assertValidPackage", () => {
  test("passes a multisig package whose witnesses all sign the merkleRoot", () => {
    const w = makeWitness(MERKLE_ROOT);
    const pkg = {
      signingPayload,
      nativeScript: { type: "all", scripts: [{ type: "sig", keyHash: w.key }] },
      signatures: [w],
    };
    expect(assertValidPackage(pkg)).toBe(true);
  });

  test("passes a key-based package with one valid witness", () => {
    const w = makeWitness(MERKLE_ROOT);
    expect(assertValidPackage({ signingPayload, signatures: [w] })).toBe(true);
  });

  test("REGRESSION: rejects a cosigner who signed the evidence voteHash", () => {
    const good = makeWitness(MERKLE_ROOT);
    const bad = makeWitness(VOTE_HASH); // the all-of-2 bug: signed the wrong hash
    const pkg = {
      signingPayload,
      nativeScript: {
        type: "all",
        scripts: [
          { type: "sig", keyHash: good.key },
          { type: "sig", keyHash: bad.key },
        ],
      },
      signatures: [good, bad],
    };
    expect(() => assertValidPackage(pkg)).toThrow(PackageInvariantError);
    expect(() => assertValidPackage(pkg)).toThrow(/MESSAGE_MISMATCH/);
  });

  test("rejects a package with a tampered signature", () => {
    const w = makeWitness(MERKLE_ROOT, { tamper: true });
    expect(() => assertValidPackage({ signingPayload, signatures: [w] })).toThrow(
      /SIGNATURE_INVALID/
    );
  });

  test("rejects a multisig package below threshold even if its one witness is valid", () => {
    const a = makeWitness(MERKLE_ROOT);
    const b = makeWitness(MERKLE_ROOT);
    const pkg = {
      signingPayload,
      nativeScript: {
        type: "all",
        scripts: [
          { type: "sig", keyHash: a.key },
          { type: "sig", keyHash: b.key },
        ],
      },
      signatures: [a], // only one of two required
    };
    expect(() => assertValidPackage(pkg)).toThrow(/threshold/);
  });

  test("rejects a package with no signatures", () => {
    expect(() => assertValidPackage({ signingPayload, signatures: [] })).toThrow(/no signatures/);
  });
});
