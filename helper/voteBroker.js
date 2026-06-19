// Vote-payload broker. Given a voter and their selections, produces:
//   - the canonical SignedVotePayload the voter will sign
//   - the VoteEvidence bundle (pre-signatures) that will be pinned to IPFS
//   - a blake2b_256 voteHash and merkle-proof scaffold
//   - a reserved nonce (via nonceManager)
//
// The broker is the single producer of these bytes; multisig cosigners sign
// the *same* canonical payload so signatures aggregate cleanly.
//
// Hydra's exact merkle-proof shape is pulled from the ballot definition
// published by the Hydra service (see ~/ekklesia/hydra/src/types.ts). For
// now we build a compatible scaffold; the proof steps are populated when
// the ballot's question tree is available (TODO: enrich via hydraClient.ballot()
// or a local ballot-definition cache).

import blake from "blakejs";
import { canonicalize, canonicalBytes } from "./canonicalJson.js";
import * as nonceManager from "./nonceManager.js";

/**
 * Evidence/results protocol version. Bumped from `ekklesia/1.0` to
 * `ekklesia/2.0` for the post-audit cut-over (findings F-006/F-007): the
 * version that ships the unified, canonically-hashed evidence bundle shared
 * with the Hydra middleware (which emits the same `PROTOCOL_VERSION`).
 *
 * The two ballots that already settled keep their pinned `ekklesia/1.0`
 * evidence and still verify — the broker only stamps NEW votes, and nothing
 * here re-mints a historical bundle. Replay tooling selects its verification
 * path by the bundle's own declared version.
 */
export const PROTOCOL_VERSION = "ekklesia/2.0";

export class BrokerError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function blake2b256Hex(bytes) {
  return Buffer.from(blake.blake2b(bytes, null, 32)).toString("hex");
}

/**
 * Build the SignedVotePayload in canonical (RFC-8785) form. The whole payload
 * — top-level keys AND the keys of every vote object inside `votes[]` — is run
 * through `canonicalize` so the serialization is deterministic regardless of
 * the key insertion order the client happened to use. Array order (the order of
 * vote objects, and of `selection` entries) is preserved; only object keys are
 * sorted.
 *
 * This is the load-bearing step for cross-platform reproducibility: any
 * Ekklesia interface that builds the same logical { ballotId, nonce, votes }
 * arrives at the same bytes here, hence the same merkleRoot, hence a signature
 * any other platform can reproduce and verify. (Without it, a vote such as
 * `{ questionId, abstain: true }` — non-alphabetical keys — serialized to
 * different bytes on different clients.)
 *
 * `JSON.parse(canonicalize(...))` yields a plain object whose own serialization
 * is already canonical, so downstream `JSON.stringify` (e.g. Hydra's verifier
 * today) reproduces these exact bytes.
 */
export function buildSigningPayload({ ballotId, nonce, votes }) {
  if (!ballotId || typeof nonce !== "number" || !Array.isArray(votes)) {
    throw new BrokerError("ballotId, nonce, and votes[] are required", { code: "BAD_INPUT" });
  }
  return JSON.parse(canonicalize({ ballotId, nonce, votes }));
}

/**
 * Assemble the VoteEvidence bundle (pre-signature). Witnesses/nativeScript
 * are filled in after signatures are collected.
 */
export function buildEvidence({
  ballotId,
  voterId,
  credentialHrp,
  nonce,
  votes,
  surveyTxId,
  responderRole,
  merkleProof = { root: "", steps: [] },
}) {
  const signedPayload = buildSigningPayload({ ballotId, nonce, votes });
  return {
    specVersion: PROTOCOL_VERSION,
    surveyTxId: surveyTxId || ballotId,
    responderRole: responderRole || "Voter",
    // Reuse the canonical votes from the signing payload so `answers` and the
    // signed payload are the exact same bytes (and what we submit to Hydra).
    answers: signedPayload.votes,
    ekklesia: {
      voterId,
      credentialHrp,
      nonce,
      signedPayload,
      witnesses: [],
      merkleProof,
    },
  };
}

/**
 * Compute the on-chain voteHash from an Evidence object. Since the evidence
 * hash is what goes on chain, signatures must be added *before* this is
 * computed for the final submission — but the broker publishes the pre-
 * signature hash too for the voter to verify they're signing the intended
 * selections.
 */
export function voteHash(evidence) {
  return blake2b256Hex(canonicalBytes(evidence));
}

/**
 * The merkleRoot is the ONLY thing a voter (and every multisig cosigner)
 * signs: `blake2b_256(canonicalBytes(signingPayload))` as a 64-char hex string.
 *
 * It is hashed over the SHARED canonical (RFC-8785) JSON so that the same
 * logical { ballotId, nonce, votes } always produces the same merkleRoot on
 * every platform — a globally reproducible "expected ballot hash" for a given
 * voter + selections (see HYDRA_CANONICAL_SIGNING_PAYLOAD). `buildSigningPayload`
 * already returns a canonical-ordered payload, so for our own drafts this equals
 * `JSON.stringify(signingPayload)`; using `canonicalBytes` keeps it correct even
 * if a non-canonical payload is ever passed in.
 *
 * It is NOT the evidence `voteHash` — that hashes the whole VoteEvidence bundle
 * (a superset), so the two values are never equal. Serving voteHash as the
 * signing target made cosigners sign the wrong message; this single helper is
 * the one place merkleRoot is derived so no caller can drift.
 */
export function merkleRootHex(signingPayload) {
  return blake2b256Hex(canonicalBytes(signingPayload));
}

/**
 * End-to-end payload construction in one call. Reserves a nonce and returns
 * everything the route needs to respond to a draft request.
 *
 * When `reuseNonce` is passed, the caller owns a pre-reserved nonce from
 * an existing VotePackage and buildDraft skips reserveNext — this is how
 * the idempotent /draft upsert updates selections on an in-flight package
 * without burning a new nonce. Hydra requires nonce === currentVersion + 1
 * strictly, so a new reservation per /draft click would drift the backend
 * out of sync with Hydra's expected next nonce.
 *
 * @param {Object} input
 * @param {string} input.ballotId
 * @param {string} input.voterId        — bech32
 * @param {string} input.credentialHrp  — "drep"|"stake"|"pool"|"calidus"
 * @param {Array} input.votes           — VoteSelection[]
 * @param {string} [input.responderRole]
 * @param {Object} [input.merkleProof]  — supplied when the caller has it
 * @param {number} [input.reuseNonce]   — when present, skips reserveNext
 */
export async function buildDraft({
  ballotId,
  voterId,
  credentialHrp,
  votes,
  responderRole,
  merkleProof,
  reuseNonce,
}) {
  if (!ballotId || !voterId || !credentialHrp) {
    throw new BrokerError("ballotId, voterId, credentialHrp required", { code: "BAD_INPUT" });
  }
  const nonce =
    typeof reuseNonce === "number"
      ? reuseNonce
      : await nonceManager.reserveNext({ userId: voterId, ballotId });
  const evidence = buildEvidence({
    ballotId,
    voterId,
    credentialHrp,
    nonce,
    votes,
    responderRole,
    merkleProof,
  });
  const signingPayload = evidence.ekklesia.signedPayload;

  // The voter signs the 64-char hex merkleRoot string (UTF-8 bytes), NOT the
  // raw signedPayload JSON. merkleRoot is hashed over the canonical bytes of the
  // signing payload (see merkleRootHex). `signingPayload` is already canonical,
  // so `JSON.stringify(signingPayload)` here is byte-identical to those canonical
  // bytes — which is exactly what Hydra's verifier reproduces from the votes we
  // submit. (Hydra's verifier should also canonicalize for robustness against
  // clients that submit non-canonical order — tracked in
  // HYDRA_CANONICAL_SIGNING_PAYLOAD.)
  const signedPayloadJson = JSON.stringify(signingPayload);
  const merkleRoot = merkleRootHex(signingPayload);
  // cardano-signer --data-hex takes the hex of the bytes to sign. We sign
  // the UTF-8 bytes of the merkleRoot hex string, so signingPayloadHex
  // is the hex of those ASCII bytes.
  const signingPayloadHex = Buffer.from(merkleRoot, "utf8").toString("hex");

  return {
    nonce,
    signingPayload,
    signedPayloadJson,
    merkleRoot,
    signingPayloadHex,
    evidence,
    prelimVoteHash: voteHash(evidence),
  };
}

/**
 * Finalize an Evidence bundle by attaching witnesses + optional native script
 * + optional calidus declaration, then compute the final voteHash.
 */
export function finalizeEvidence(evidence, { witnesses, nativeScript, calidusDeclaration }) {
  const e = evidence.ekklesia;
  // Rebuild ekklesia with the exact key order the Hydra producer emits
  // (hydra/src/routes/voting.ts): the optional nativeScript / calidusDeclaration
  // extension keys sit BETWEEN witnesses and merkleProof, and appear only for
  // the credential types that use them. Keeps the two producers' bundles
  // byte-identical (F-007). voteHash is canonical so key order doesn't change
  // it, but the pinned bundle shape must still match.
  const finalized = {
    ...evidence,
    ekklesia: {
      voterId: e.voterId,
      credentialHrp: e.credentialHrp,
      nonce: e.nonce,
      signedPayload: e.signedPayload,
      witnesses: witnesses ?? [],
      ...(nativeScript ? { nativeScript } : {}),
      ...(calidusDeclaration ? { calidusDeclaration } : {}),
      merkleProof: e.merkleProof,
    },
  };
  return { evidence: finalized, voteHash: voteHash(finalized) };
}
