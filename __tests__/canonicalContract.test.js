// F-006 (backend half): the backend hashes voteHash over the SHARED RFC-8785
// canonical JSON (@lerna-labs/ekklesia-helpers/json), byte-for-byte identical to
// the Hydra middleware, so the same evidence bundle always yields the same
// voteHash regardless of who produced it or in what key order. This is the
// cross-repo contract test — pair it with hydra's tests/f006-canonical-votehash.
//
// The merkleRoot is deliberately NOT canonicalized: it is the value the voter
// signs, on a fixed JSON.stringify insertion-order contract shared with Hydra
// and the wallet. Canonicalizing it would invalidate signatures.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import blake from "blakejs";
import { canonicalize, canonicalBytes } from "../helper/canonicalJson.js";
import { canonicalize as sharedCanonicalize } from "@lerna-labs/ekklesia-helpers/json";
import { voteHash } from "../helper/voteBroker.js";

const here = dirname(fileURLToPath(import.meta.url));

// The exact cross-repo vector from hydra/tests/f006-canonical-votehash.test.ts:
// two logically-identical bundles built with different key insertion order.
const evA = {
  specVersion: "ekklesia/2.0",
  surveyTxId: "ballot_tx",
  responderRole: "drep",
  answers: [{ questionId: "q1", selection: [1] }],
  ekklesia: { voterId: "drep1abc", credentialHrp: "drep", nonce: 1 },
};
const evB = {
  ekklesia: { nonce: 1, credentialHrp: "drep", voterId: "drep1abc" },
  answers: [{ selection: [1], questionId: "q1" }],
  responderRole: "drep",
  surveyTxId: "ballot_tx",
  specVersion: "ekklesia/2.0",
};

// blake2b_256( canonicalBytes(evA) ) — computed with the shared helper; the
// SAME value hydra's voteHash produces for this bundle (same shared
// canonicalBytes + standard blake2b-256). Freezing it pins the cross-repo
// contract, not just internal self-consistency.
const GOLDEN_VOTE_HASH = "24f5ea95d837be606853acd0c9552400726a1c69b253e106582bd9204b40778b";

describe("F-006 backend canonical JSON delegates to the shared helper", () => {
  test("canonicalJson.canonicalize is the shared RFC-8785 implementation", () => {
    expect(canonicalize(evA)).toBe(sharedCanonicalize(evA));
    expect(canonicalize(evA)).toBe(
      '{"answers":[{"questionId":"q1","selection":[1]}],"ekklesia":' +
        '{"credentialHrp":"drep","nonce":1,"voterId":"drep1abc"},' +
        '"responderRole":"drep","specVersion":"ekklesia/2.0","surveyTxId":"ballot_tx"}'
    );
  });

  test("canonicalBytes returns a Node Buffer (consumers rely on Buffer semantics)", () => {
    expect(Buffer.isBuffer(canonicalBytes(evA))).toBe(true);
  });
});

describe("F-006 voteHash is canonical and key-order independent", () => {
  test("the two key orderings differ under JSON.stringify (the old bug surface)", () => {
    expect(JSON.stringify(evA)).not.toBe(JSON.stringify(evB));
  });

  test("but hash to the SAME voteHash under canonical JSON", () => {
    expect(voteHash(evA)).toBe(voteHash(evB));
  });

  test("voteHash matches the cross-repo golden vector hydra produces", () => {
    expect(voteHash(evA)).toBe(GOLDEN_VOTE_HASH);
    expect(voteHash(evB)).toBe(GOLDEN_VOTE_HASH);
  });

  test("voteHash equals blake2b_256 over the shared canonical bytes", () => {
    const direct = Buffer.from(blake.blake2b(canonicalBytes(evA), null, 32)).toString("hex");
    expect(voteHash(evA)).toBe(direct);
  });
});

describe("F-006 structural guard — both voteHash and merkleRoot are canonical", () => {
  const src = readFileSync(resolve(here, "../helper/voteBroker.js"), "utf-8");

  test("voteHash() hashes over canonicalBytes(evidence)", () => {
    expect(src).toMatch(/blake2b256Hex\(canonicalBytes\(evidence\)\)/);
  });

  test("merkleRoot is now hashed over canonicalBytes(signingPayload) for global reproducibility", () => {
    // Updated from the F-006-era "merkleRoot stays insertion-order" stance: the
    // signing payload is now canonicalized too so every platform reproduces the
    // same ballot hash. buildSigningPayload normalizes key order, so the bytes
    // Hydra JSON.stringify's still match. See HYDRA_CANONICAL_SIGNING_PAYLOAD.
    expect(src).toMatch(/blake2b256Hex\(canonicalBytes\(signingPayload\)\)/);
    expect(src).toMatch(/JSON\.parse\(canonicalize\(\{ ballotId, nonce, votes \}\)\)/);
  });
});
