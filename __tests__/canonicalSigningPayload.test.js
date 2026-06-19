// The signing payload (the bytes behind merkleRoot) is canonicalized so the
// "expected ballot hash" for a given voter + selections is globally
// reproducible: any Ekklesia platform that builds the same logical vote arrives
// at the same merkleRoot, regardless of the key order it used. See
// HYDRA_CANONICAL_SIGNING_PAYLOAD.
//
// Safe against the current Hydra verifier (which JSON.stringify's the payload):
// because buildSigningPayload stores the votes in canonical key order, the
// votes we submit re-stringify to the exact canonical bytes Hydra hashes.

import blake from "blakejs";
import { canonicalize, canonicalBytes } from "../helper/canonicalJson.js";
import {
  buildSigningPayload,
  buildEvidence,
  merkleRootHex,
} from "../helper/voteBroker.js";

const blake2b256Hex = (bytes) => Buffer.from(blake.blake2b(bytes, null, 32)).toString("hex");

describe("global reproducibility of merkleRoot", () => {
  // Same logical vote, built by two platforms with different key insertion
  // order — including a non-alphabetical `{ questionId, abstain }` vote.
  const votesA = [
    { questionId: "q1", abstain: true },
    { questionId: "q2", selection: [3, 1] },
  ];
  const votesB = [
    { abstain: true, questionId: "q1" },
    { selection: [3, 1], questionId: "q2" },
  ];
  const args = { ballotId: "6a1512d782978c99456fe6de", nonce: 1 };
  const pA = buildSigningPayload({ ...args, votes: votesA });
  const pB = buildSigningPayload({ ...args, votes: votesB });

  test("two key orderings serialize to the SAME bytes", () => {
    expect(JSON.stringify(pA)).toBe(JSON.stringify(pB));
  });

  test("and produce the SAME merkleRoot", () => {
    expect(merkleRootHex(pA)).toBe(merkleRootHex(pB));
    expect(merkleRootHex(pA)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("merkleRoot is blake2b_256 over the canonical bytes", () => {
    expect(merkleRootHex(pA)).toBe(blake2b256Hex(canonicalBytes(pA)));
  });

  test("array order is preserved (vote order and selection order are NOT sorted)", () => {
    expect(pA.votes.map((v) => v.questionId)).toEqual(["q1", "q2"]);
    expect(pA.votes[1].selection).toEqual([3, 1]); // not [1,3]
  });
});

describe("Hydra compatibility (current JSON.stringify verifier reproduces our bytes)", () => {
  const args = { ballotId: "b1", nonce: 2, votes: [{ questionId: "q1", abstain: true }] };

  test("the stored signing payload re-stringifies to the canonical bytes", () => {
    const p = buildSigningPayload(args);
    // Hydra rebuilds { ballotId, nonce, votes } and JSON.stringify's it. Because
    // our stored payload is already canonical, JSON.stringify(p) === canonical.
    expect(JSON.stringify(p)).toBe(canonicalize(args));
  });

  test("evidence answers and signedPayload.votes are the same canonical votes", () => {
    const ev = buildEvidence({
      ...args,
      voterId: "drep1abc",
      credentialHrp: "drep",
    });
    expect(ev.answers).toEqual(ev.ekklesia.signedPayload.votes);
    expect(JSON.stringify(ev.answers)).toBe(JSON.stringify(ev.ekklesia.signedPayload.votes));
  });
});

describe("no regression for already-canonical votes (settled-ballot shape)", () => {
  // A plain { questionId, selection } vote has alphabetical keys, so the
  // canonical merkleRoot equals the old insertion-order JSON.stringify hash —
  // existing/settled votes of this shape are unaffected by the change.
  const args = { ballotId: "b1", nonce: 1, votes: [{ questionId: "q1", selection: [1] }] };

  test("canonical merkleRoot equals the old JSON.stringify merkleRoot", () => {
    const p = buildSigningPayload(args);
    const oldStyle = blake2b256Hex(Buffer.from(JSON.stringify(args), "utf8"));
    expect(merkleRootHex(p)).toBe(oldStyle);
  });
});
