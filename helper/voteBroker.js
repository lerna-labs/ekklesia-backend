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
 * Build the canonical SignedVotePayload. The voter signs these exact bytes
 * (COSE_Sign1 over `canonicalize(payload)` UTF-8).
 */
export function buildSigningPayload({ ballotId, nonce, votes }) {
  if (!ballotId || typeof nonce !== "number" || !Array.isArray(votes)) {
    throw new BrokerError("ballotId, nonce, and votes[] are required", { code: "BAD_INPUT" });
  }
  return { ballotId, nonce, votes };
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
    specVersion: "ekklesia/1.0",
    surveyTxId: surveyTxId || ballotId,
    responderRole: responderRole || "Voter",
    answers: votes,
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
 * End-to-end payload construction in one call. Reserves a nonce and returns
 * everything the route needs to respond to a draft request.
 *
 * @param {Object} input
 * @param {string} input.ballotId
 * @param {string} input.voterId        — bech32
 * @param {string} input.credentialHrp  — "drep"|"stake"|"pool"|"addr_vkh"
 * @param {Array} input.votes           — VoteSelection[]
 * @param {string} [input.responderRole]
 * @param {Object} [input.merkleProof]  — supplied when the caller has it
 */
export async function buildDraft({
  ballotId,
  voterId,
  credentialHrp,
  votes,
  responderRole,
  merkleProof,
}) {
  if (!ballotId || !voterId || !credentialHrp) {
    throw new BrokerError("ballotId, voterId, credentialHrp required", { code: "BAD_INPUT" });
  }
  const nonce = await nonceManager.reserveNext({ userId: voterId, ballotId });
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
  const signingPayloadCanonical = canonicalize(signingPayload);
  const signingPayloadHex = Buffer.from(signingPayloadCanonical, "utf8").toString("hex");

  return {
    nonce,
    signingPayload,
    signingPayloadCanonical,
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
  const finalized = {
    ...evidence,
    ekklesia: {
      ...evidence.ekklesia,
      witnesses: witnesses ?? [],
    },
  };
  if (nativeScript) finalized.ekklesia.nativeScript = nativeScript;
  if (calidusDeclaration) finalized.ekklesia.calidusDeclaration = calidusDeclaration;
  return { evidence: finalized, voteHash: voteHash(finalized) };
}
