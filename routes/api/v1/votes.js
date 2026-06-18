// Broker-side vote endpoints for Hydra ballots (v1).
//
//   POST /api/v1/votes/:ballotId/draft
//         body: { votes: VoteSelection[], nativeScript?, calidusDeclaration? }
//         Reserves a nonce, stores a VotePackage in "draft"/"awaiting-
//         signatures", returns the canonical signing payload.
//         `responderRole` is derived server-side from the authenticated
//         credential's HRP — client-supplied values on the body are
//         ignored. Hydra likewise re-derives the role from credential
//         HRP at settlement, so the two layers stay in agreement.
//
//   POST /api/v1/votes/:ballotId/signature
//         body: { packageId, witness: { coseSign1Hex, coseKeyHex, ...? } }
//         Minimum body is the two hex strings CIP-30 signData returns;
//         the backend derives `key` (blake2b_224 of pub key), `signature`
//         (raw ed25519 sig extracted from the COSE_Sign1), and
//         `publicKey` from those. Pre-supplied fields are preserved.
//         Appends a witness; promotes the package when the native-script
//         threshold is met, or immediately for key-based voters.
//         Triggers submission synchronously on the final signature.
//
//   POST /api/v1/votes/:ballotId/submit
//         body: { packageId }
//         Manual trigger. Idempotent — no-op once the package is confirmed.
//
//   GET  /api/v1/votes/:ballotId/package/:packageId
//         Returns the current package state.
//
// Auth: regular voter session (verifyToken). Broker enforces that the
// authenticated userId matches the package's userId.

import { Router } from "express";
import { verifyToken } from "../../../helper/verifyToken.js";
import { Ballot } from "../../../schema/Ballot.js";
import { VotePackage } from "../../../schema/VotePackage.js";
import { checkVoterValidation } from "../../../helper/voterValidation.js";
import { syncVoteRecords } from "../../../helper/voteMirror.js";
import { loadValidationScript } from "../../../helper/loadValidationScript.js";
import {
  buildDraft,
  BrokerError,
  merkleRootHex,
} from "../../../helper/voteBroker.js";
import { validateVotesForBallot } from "../../../helper/voteValidation.js";
import { canonicalize } from "../../../helper/canonicalJson.js";
import {
  status as multisigStatus,
  dedupeSignatures,
  MultisigError,
} from "../../../helper/multisigCollector.js";
import {
  normalizeWitness,
  CoseWitnessError,
  verifyWitnessAgainstMerkleRoot,
} from "../../../helper/coseWitness.js";
import { User } from "../../../schema/User.js";
import * as nonceManager from "../../../helper/nonceManager.js";
import { forBallot, HydraClientError } from "../../../helper/hydraClient.js";
import { credentialHrp, responderRoleFor } from "../../../helper/voterCredential.js";
import { voteWriteLimiter } from "../../../helper/rateLimiters.js";
import { checkVotingWindow } from "../../../helper/votingWindow.js";
import { resolveBallot } from "../../../helper/idResolver.js";

const router = Router();

// Apply the write-path limiter to every mutating broker endpoint.
router.use(voteWriteLimiter);

/**
 * Normalized error codes returned alongside the existing `status: "error"`
 * envelope on broker endpoints. The frontend uses these to route UX
 * (retry, re-draft, "ask another cosigner", etc.) without string-matching
 * the human-readable message.
 *
 *   BAD_INPUT          — missing / malformed body fields
 *   ELIGIBILITY_DENIED — voter not in UserCache.validated for this ballot
 *   PACKAGE_NOT_FOUND  — packageId not on this ballot
 *   FORBIDDEN          — session userId doesn't own the package
 *   PACKAGE_TERMINAL   — package is in a terminal state (hydra-confirmed,
 *                        failed, cancelled) and can't accept more signatures
 *   SIGNATURE_INVALID  — Hydra rejected the witness (sig + message + key)
 *   NONCE_STALE        — Hydra rejected the submission's nonce as stale
 *                        (replay or out-of-order attempt)
 *   HYDRA_UPSTREAM     — any other Hydra-side failure (timeout, 5xx, etc.)
 *   INTERNAL           — unexpected server error
 */
export const ERROR_CODES = Object.freeze({
  BAD_INPUT: "BAD_INPUT",
  ELIGIBILITY_DENIED: "ELIGIBILITY_DENIED",
  PACKAGE_NOT_FOUND: "PACKAGE_NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  PACKAGE_TERMINAL: "PACKAGE_TERMINAL",
  // Voter called /draft with different selections on a package that
  // already has collected signatures (multisig mid-flight). Mutating
  // the payload would invalidate cosigner sigs. Voter must DELETE
  // the package and redraft fresh.
  PACKAGE_ALREADY_SIGNED: "PACKAGE_ALREADY_SIGNED",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  NONCE_STALE: "NONCE_STALE",
  HYDRA_UPSTREAM: "HYDRA_UPSTREAM",
  INTERNAL: "INTERNAL",
});

// Packages the voter could still act on (sign / submit / abandon).
// Anything outside this set is terminal — idempotent /draft skips it
// when looking for an active resume target, DELETE 404s on it, and
// the TTL sweep leaves it alone.
const NON_TERMINAL_STATUSES = Object.freeze([
  "draft",
  "awaiting-signatures",
  "awaiting-submission",
]);

/**
 * Canonical byte compare: two /draft calls with identical votes[]
 * produce the same canonicalJson bytes for the signingPayload.votes
 * field. Ballot + voter + nonce are constant for any given package,
 * so comparing just the votes array is sufficient.
 */
function sameSelections(storedVotes, incomingVotes) {
  try {
    return (
      canonicalize(storedVotes || []) ===
      canonicalize(incomingVotes || [])
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort map from a Hydra HydraClientError to a normalized broker
 * error code. Hydra's own `code` field already speaks a similar language
 * (SIGNATURE_INVALID, NONCE_STALE in some flows); we recognize a couple
 * of common patterns and fall back to HYDRA_UPSTREAM.
 */
function hydraErrorCode(err) {
  const code = (err?.code || "").toUpperCase();
  if (!code) return ERROR_CODES.HYDRA_UPSTREAM;
  if (code.includes("SIGNATURE")) return ERROR_CODES.SIGNATURE_INVALID;
  if (code.includes("NONCE")) return ERROR_CODES.NONCE_STALE;
  if (code.includes("REPLAY")) return ERROR_CODES.NONCE_STALE;
  return ERROR_CODES.HYDRA_UPSTREAM;
}

function requireSession(req, res) {
  const t = verifyToken(req);
  if (t.status !== "success") {
    res.status(t.code || 401).json({ status: "error", message: t.message });
    return null;
  }
  return t;
}

async function requireHydraBallot(req, res) {
  // Accept the canonical _id or the upstream externalBallotId. The
  // broker downstream addresses Hydra by the canonical _id, so the
  // resolver flattens the alias before any in-head call runs.
  const result = await resolveBallot(req.params.ballotId);
  if (!result) {
    res.status(404).json({ status: "error", message: "Ballot not found" });
    return null;
  }
  if (result.ambiguous) {
    res.status(409).json({
      status: "error",
      code: "ID_COLLISION",
      message: "External ballot id matches multiple ballots; use the canonical _id",
      candidates: result.ambiguous,
    });
    return null;
  }
  const ballot = result.doc;
  if (ballot.source !== "hydra") {
    res.status(400).json({
      status: "error",
      message: "Ballot is not Hydra-backed; writes land via v0 archive or future versions",
    });
    return null;
  }
  return ballot;
}

// Write-path gate: rejects drafts/signatures/submissions when the ballot
// is outside its vote window. Not applied to GET or DELETE (voters must
// still read and cancel in-flight packages after close). Applied to
// /signature as well as /draft and /submit — a cosigner's witness
// completing after votePeriodEnd would let a stale package submit.
function requireVotingOpen(res, ballot) {
  const check = checkVotingWindow(ballot);
  if (!check.ok) {
    res.status(409).json({
      status: "error",
      code: check.code,
      message: check.message,
    });
    return false;
  }
  return true;
}

// POST /:ballotId/draft
router.post("/:ballotId/draft", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;
  if (!requireVotingOpen(res, ballot)) return;

  const { votes, calidusDeclaration } = req.body || {};
  let nativeScript = req.body?.nativeScript || null;
  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({ status: "error", code: ERROR_CODES.BAD_INPUT, message: "votes[] required" });
  }

  // Derive responderRole from the authenticated voter's bech32 prefix,
  // not from the request body. A client supplying `responderRole: "CC"`
  // (or any other string) used to land verbatim in the local evidence
  // bundle and prelim hash, causing the prelim hash to diverge from
  // Hydra's settlement-time hash — Hydra now re-derives the role from
  // credential HRP. Mirror that mapping here so the two never drift.
  const derivedResponderRole = responderRoleFor(session.userId);
  if (!derivedResponderRole) {
    return res.status(400).json({
      status: "error",
      code: ERROR_CODES.BAD_INPUT,
      message: "Voter credential HRP is not a supported role",
    });
  }

  // Shape + per-method constraint validation (friendly pre-flight so
  // voters don't round-trip to Hydra for known-bad payloads; also
  // enforces the knapsack cost-cap on budget proposals, which Hydra
  // multi-choice does not natively check).
  const vv = await validateVotesForBallot(votes, ballot._id);
  if (!vv.ok) {
    return res.status(400).json({
      status: "error",
      code: ERROR_CODES.BAD_INPUT,
      message: vv.error.message,
      path: vv.error.path,
    });
  }

  // Eligibility gate. On cache miss — or a cached row flagged
  // validated: false that might be stale — fall through to the
  // ballot's voterValidationScript for an on-demand Koios/Blockfrost
  // lookup. This is the "lazy validation" model: don't pre-enumerate
  // every potentially eligible DRep / SPO / stake credential at
  // ballot start (which could be millions of rows for a stake
  // ballot); instead, validate the specific voter when they show up
  // to vote. The per-group validator writes the authoritative
  // UserCache row + votingPower as part of its return path.
  const cached = await checkVoterValidation(session.userId, ballot._id);
  let validated = Boolean(cached?.validated);
  if (!cached || !cached.validated) {
    try {
      const mod = await loadValidationScript(ballot.voterValidationScript);
      if (typeof mod?.validateVoter === "function") {
        validated = Boolean(await mod.validateVoter(session.userId, ballot._id));
      } else {
        console.warn(
          `[votes/draft] validation script ${ballot.voterValidationScript} exports no validateVoter`
        );
      }
    } catch (err) {
      console.error("[votes/draft] validation script failed:", err);
      return res.status(502).json({
        status: "error",
        code: ERROR_CODES.HYDRA_UPSTREAM,
        message: "Voter validation unavailable — try again shortly",
      });
    }
  }
  if (!validated) {
    return res.status(403).json({ status: "error", code: ERROR_CODES.ELIGIBILITY_DENIED, message: "Voter is not eligible for this ballot" });
  }

  // Multisig voters: if the caller didn't include a nativeScript, pull
  // the cached one from the User doc (populated at login). Body override
  // still wins when explicitly supplied.
  if (!nativeScript && session.multiSig) {
    const user = await User.findById(session.userId).lean();
    if (user?.nativeScript) nativeScript = user.nativeScript;
  }

  try {
    // Idempotent upsert: one active package per voter+ballot at a time.
    // Hydra requires strict nonce === currentVersion + 1, so burning a
    // fresh nonce on every /draft click would leave the stored nonce
    // ahead of Hydra's expected next value. Instead, we resume or
    // mutate the existing active package and only reserve a new nonce
    // when none exists.
    const existing = await VotePackage.findOne({
      ballotId: ballot._id,
      userId: session.userId,
      status: { $in: NON_TERMINAL_STATUSES },
    }).sort({ createdAt: -1 });

    let pkg;
    let draft;

    if (existing) {
      const identical = sameSelections(existing.signingPayload?.votes, votes);

      if (!identical && (existing.signatures || []).length > 0) {
        // Mutating selections on a package cosigners have already
        // signed would invalidate their work. Make the voter explicitly
        // DELETE and redraft.
        return res.status(409).json({
          status: "error",
          code: ERROR_CODES.PACKAGE_ALREADY_SIGNED,
          message:
            "This package already has collected signatures. Cancel it first, then create a new draft.",
          package: { id: existing._id.toString(), status: existing.status, nonce: existing.nonce },
        });
      }

      // Reuse the existing reservation — no new nonce burn.
      draft = await buildDraft({
        ballotId: ballot._id.toString(),
        voterId: session.userId,
        credentialHrp: credentialHrp(session.userId),
        votes,
        responderRole: derivedResponderRole,
        reuseNonce: existing.nonce,
      });

      existing.signingPayload = draft.signingPayload;
      existing.voteHash = draft.prelimVoteHash;
      existing.lastActivityAt = new Date();
      if (!identical) {
        // Selections actually changed — clear any stale sig draft state
        // (multisig: signatures is empty at this branch per the check
        // above; single-sig: no-op).
        existing.signatures = [];
      }
      await existing.save();
      pkg = existing;
    } else {
      draft = await buildDraft({
        ballotId: ballot._id.toString(),
        voterId: session.userId,
        credentialHrp: credentialHrp(session.userId),
        votes,
        responderRole: derivedResponderRole,
      });
      pkg = await VotePackage.create({
        ballotId: ballot._id,
        userId: session.userId,
        signingPayload: draft.signingPayload,
        nonce: draft.nonce,
        voteHash: draft.prelimVoteHash,
        nativeScript: nativeScript || null,
        calidusDeclaration: calidusDeclaration || null,
        status: "awaiting-signatures",
        lastActivityAt: new Date(),
      });
    }

    let multisig = null;
    if (pkg.nativeScript) {
      multisig = multisigStatus(pkg.nativeScript, pkg.signatures || []);
    }

    return res.status(existing ? 200 : 201).json({
      status: "success",
      package: {
        id: pkg._id.toString(),
        status: pkg.status,
        nonce: pkg.nonce,
      },
      signingPayload: draft.signingPayload,
      signingPayloadHex: draft.signingPayloadHex,
      // `merkleRoot` is the 64-char hex string the voter must sign (UTF-8
      // bytes). Hydra's verifySignature compares the COSE payload ASCII
      // against this exact string — see hydra-sdk verify-signature.js:38.
      merkleRoot: draft.merkleRoot,
      signedPayloadJson: draft.signedPayloadJson,
      prelimVoteHash: draft.prelimVoteHash,
      multisig,
    });
  } catch (err) {
    if (err instanceof BrokerError) {
      return res.status(400).json({ status: "error", code: err.code, message: err.message });
    }
    console.error("[votes/draft] error:", err);
    return res.status(500).json({ status: "error", code: ERROR_CODES.INTERNAL, message: "Server error" });
  }
});

// POST /:ballotId/signature
router.post("/:ballotId/signature", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;
  if (!requireVotingOpen(res, ballot)) return;

  const { packageId, witness: rawWitness } = req.body || {};
  if (!packageId || !rawWitness) {
    return res.status(400).json({ status: "error", code: ERROR_CODES.BAD_INPUT, message: "packageId and witness required" });
  }

  // CIP-30 `signData` returns only { signature (COSE_Sign1 hex), key (COSE key hex) }.
  // Derive the remaining fields (keyHash, raw pub key, raw ed25519 sig) so
  // multisigCollector has what it needs and our Mongo audit trail is complete.
  let witness;
  try {
    witness = normalizeWitness(rawWitness);
  } catch (err) {
    if (err instanceof CoseWitnessError) {
      return res.status(400).json({ status: "error", code: err.code, message: err.message });
    }
    throw err;
  }

  const pkg = await VotePackage.findOne({ _id: packageId, ballotId: ballot._id });
  if (!pkg) return res.status(404).json({ status: "error", code: ERROR_CODES.PACKAGE_NOT_FOUND, message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", code: ERROR_CODES.FORBIDDEN, message: "Not the package owner" });
  }
  if (!["draft", "awaiting-signatures"].includes(pkg.status)) {
    return res.status(409).json({ status: "error", code: ERROR_CODES.PACKAGE_TERMINAL, message: `Package in terminal state: ${pkg.status}` });
  }

  // Verify the witness BEFORE storing it. Recompute the merkleRoot from the
  // package's own signingPayload (single source of truth) and confirm the
  // COSE_Sign1 both (a) signs that exact value and (b) is a valid Ed25519
  // signature. Previously the route stored any witness that passed key
  // membership, so a signature over the wrong message (the evidence voteHash)
  // was accepted, counted toward the threshold, and submitted to Hydra.
  if (!pkg.signingPayload) {
    return res.status(409).json({ status: "error", code: ERROR_CODES.BAD_INPUT, message: "Package has no signing payload to verify against" });
  }
  let verification;
  try {
    verification = verifyWitnessAgainstMerkleRoot(witness, merkleRootHex(pkg.signingPayload));
  } catch (err) {
    if (err instanceof CoseWitnessError) {
      return res.status(400).json({ status: "error", code: ERROR_CODES.SIGNATURE_INVALID, message: err.message });
    }
    throw err;
  }
  if (!verification.ok) {
    return res.status(400).json({ status: "error", code: ERROR_CODES.SIGNATURE_INVALID, message: verification.reason });
  }

  pkg.signatures = dedupeSignatures([...(pkg.signatures || []), witness]);
  pkg.lastActivityAt = new Date();

  let readyToSubmit = false;
  if (pkg.nativeScript) {
    try {
      const s = multisigStatus(pkg.nativeScript, pkg.signatures);
      if (s.satisfied) {
        pkg.status = "awaiting-submission";
        readyToSubmit = true;
      }
    } catch (err) {
      if (err instanceof MultisigError) {
        return res.status(400).json({ status: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  } else {
    // Key-based voter: a single witness is enough.
    pkg.status = "awaiting-submission";
    readyToSubmit = true;
  }

  await pkg.save();

  if (readyToSubmit) {
    // Fire-and-await: submission is in-line so the caller sees the final state.
    const result = await submitPackage(pkg, ballot).catch((err) => ({ ok: false, err }));
    if (!result.ok) {
      return res.status(502).json({
        status: "error",
        code: hydraErrorCode(result.err),
        message: `Submission failed: ${result.err?.message || "unknown"}`,
        package: await currentPackageView(pkg._id),
      });
    }
    return res.json({
      status: "success",
      submitted: true,
      package: await currentPackageView(pkg._id),
    });
  }

  return res.json({
    status: "success",
    submitted: false,
    package: await currentPackageView(pkg._id),
    multisig: pkg.nativeScript ? multisigStatus(pkg.nativeScript, pkg.signatures) : null,
  });
});

// POST /:ballotId/submit — idempotent manual retry
router.post("/:ballotId/submit", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;
  if (!requireVotingOpen(res, ballot)) return;

  const { packageId } = req.body || {};
  const pkg = await VotePackage.findOne({ _id: packageId, ballotId: ballot._id });
  if (!pkg) return res.status(404).json({ status: "error", code: ERROR_CODES.PACKAGE_NOT_FOUND, message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", code: ERROR_CODES.FORBIDDEN, message: "Not the package owner" });
  }
  if (pkg.status === "hydra-confirmed") {
    return res.json({ status: "success", package: await currentPackageView(pkg._id) });
  }
  if (pkg.status !== "awaiting-submission") {
    return res.status(409).json({ status: "error", code: ERROR_CODES.PACKAGE_TERMINAL, message: `Package in state ${pkg.status}` });
  }

  // Stamp activity so a stalled /submit retry loop isn't swept by the
  // TTL cron mid-attempt. submitPackage may take a while on the Hydra
  // side; this also keeps the package alive for the voter's window.
  pkg.lastActivityAt = new Date();
  await pkg.save();

  const result = await submitPackage(pkg, ballot).catch((err) => ({ ok: false, err }));
  if (!result.ok) {
    return res.status(502).json({
      status: "error",
      code: hydraErrorCode(result.err),
      message: `Submission failed: ${result.err?.message || "unknown"}`,
      package: await currentPackageView(pkg._id),
    });
  }
  return res.json({ status: "success", package: await currentPackageView(pkg._id) });
});

// DELETE /:ballotId/package/:packageId — voter-initiated abandonment
// of an in-flight package (broker modal "Cancel" button, or the
// per-row Discard on the pending-packages dashboard alert).
//
// Terminal statuses cannot be abandoned. Non-terminal packages flip
// to "abandoned" and their reserved nonce is released — load-bearing,
// since Hydra enforces strict nonce === currentVersion + 1 and a
// non-released nonce would poison the voter's next draft attempt.
router.delete("/:ballotId/package/:packageId", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const pkg = await VotePackage.findOne({
    _id: req.params.packageId,
    ballotId: ballot._id,
  });
  if (!pkg) {
    return res
      .status(404)
      .json({ status: "error", code: ERROR_CODES.PACKAGE_NOT_FOUND, message: "Package not found" });
  }
  if (pkg.userId !== session.userId) {
    return res
      .status(403)
      .json({ status: "error", code: ERROR_CODES.FORBIDDEN, message: "Not the package owner" });
  }
  if (!NON_TERMINAL_STATUSES.includes(pkg.status)) {
    return res.status(409).json({
      status: "error",
      code: ERROR_CODES.PACKAGE_TERMINAL,
      message: `Package in terminal state: ${pkg.status}`,
    });
  }

  pkg.status = "abandoned";
  pkg.lastActivityAt = new Date();
  await pkg.save();

  // Roll back the reserved nonce so the next fresh /draft gets the
  // same value Hydra is expecting (currentVersion + 1). If some other
  // reservation has advanced the counter since this package was
  // created, release is a no-op — under idempotent /draft that
  // shouldn't happen, but the guard is defensive.
  await nonceManager.release({
    userId: pkg.userId,
    ballotId: ballot._id,
    nonce: pkg.nonce,
  });

  return res.json({
    status: "success",
    package: {
      id: pkg._id.toString(),
      status: pkg.status,
      nonce: pkg.nonce,
    },
  });
});

// GET /:ballotId/package/:packageId
router.get("/:ballotId/package/:packageId", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const pkg = await VotePackage.findOne({
    _id: req.params.packageId,
    ballotId: ballot._id,
  }).lean();
  if (!pkg) return res.status(404).json({ status: "error", code: ERROR_CODES.PACKAGE_NOT_FOUND, message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", code: ERROR_CODES.FORBIDDEN, message: "Not the package owner" });
  }
  return res.json({ status: "success", package: enrichPackageView(pkg) });
});

// GET /:ballotId/packages — list packages for the authenticated user on
// this ballot. Default returns only active (draft / awaiting-signatures /
// awaiting-submission). Pass ?includeTerminal=true OR ?status=<state>
// to broaden the filter; ?limit=N (default 10).
router.get("/:ballotId/packages", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const ACTIVE_STATUSES = ["draft", "awaiting-signatures", "awaiting-submission"];
  const filter = { ballotId: ballot._id, userId: session.userId };
  if (req.query.status) {
    filter.status = String(req.query.status);
  } else if (req.query.includeTerminal !== "true") {
    filter.status = { $in: ACTIVE_STATUSES };
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);

  const packages = await VotePackage.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return res.json({
    status: "success",
    data: packages.map(enrichPackageView),
    pagination: { limit, returned: packages.length },
  });
});

// GET /:ballotId/mine — wallet-reconnect rehydration source.
//
// CRITICAL SEMANTIC: Hydra treats every submitted vote payload as the
// voter's COMPLETE final state for the ballot — it does NOT merge
// with prior submissions. If a voter previously voted Yes on
// Proposals 2/3/4 and now submits a payload containing only their
// vote on Proposal 5, the Hydra head erases the 2/3/4 votes. The
// voter's recorded state becomes "{ Proposal 5: <selection> }" only.
//
// To AMEND votes (add a new one, change one) the frontend MUST
// rehydrate the existing confirmed votes and include them alongside
// the new/changed ones in the next /draft call. This endpoint
// surfaces exactly what's needed for that.
//
// Response shape — the split is intentional:
//
//   confirmed   The latest hydra-confirmed package's votes — the
//               source of truth for what's on-chain right now. The
//               frontend should pre-populate the selection state from
//               here. To preserve any of these votes, they MUST be
//               included in the next /draft submission.
//
//   inFlight    Packages still genuinely actionable (awaiting
//               signatures, awaiting submission, draft, or failed),
//               newest first. ONLY packages with nonce ABOVE the
//               confirmed head appear here: Hydra enforces strict
//               nonce === currentVersion + 1, so a package at/below the
//               confirmed nonce is a superseded earlier attempt that can
//               never (re)submit — surfacing it would make the editor
//               rehydrate a stale version. When one of these submits
//               successfully it REPLACES the confirmed state above. UI
//               should surface these (especially multisig packages
//               waiting on cosigner signatures) and warn the voter
//               before they create a new draft that would supersede an
//               in-flight one.
//
//   {
//     status: "success",
//     ballotId: "...",
//     confirmed: {
//       packageId, nonce, submittedAt, hydraTxId,
//       votes: { "<proposalId>": <selection>, ... }
//     } | null,
//     inFlight: [
//       { packageId, status, nonce, createdAt, votes: {...},
//         multisig?: { signaturesCollected, signaturesNeeded, satisfied } }
//     ],
//     summary: { confirmed, awaitingSignatures, awaitingSubmission,
//                draft, failed }
//   }
/**
 * Build the { confirmed, inFlight, summary } view for GET /:ballotId/mine
 * from a voter's raw VotePackage docs (any order). Pure and DB-free so it
 * can be unit-tested directly; exported for that reason.
 *
 * Load-bearing rule: Hydra enforces strict `nonce === currentVersion + 1`,
 * so a non-terminal package whose nonce is <= the latest confirmed nonce
 * is permanently unsubmittable — a superseded earlier attempt. Such
 * packages MUST NOT appear in `inFlight`, otherwise the editor rehydrates
 * a stale version from a dead/failed attempt (the first-version-sticks
 * bug). A `failed` package ABOVE the head stays in for a manual retry.
 *
 * @param {Array<object>} packages  Lean VotePackage docs.
 * @returns {{confirmed: object|null, inFlight: object[], summary: object}}
 */
export function buildMineView(packages) {
  const summary = {
    confirmed: 0,
    awaitingSignatures: 0,
    awaitingSubmission: 0,
    draft: 0,
    failed: 0,
  };

  // Per-proposal vote map mirroring the canonical wire shape the voter
  // submitted at /draft — `{ selection: number[] }` or `{ abstain: true }`
  // keyed by questionId. The Vote collection's `["abstain"]` sentinel is
  // an internal legacy collapse and is NOT part of the public contract.
  const extractVotes = (pkg) => {
    const out = {};
    for (const a of pkg.signingPayload?.votes || []) {
      const pid = a.questionId || a.proposalId;
      if (!pid) continue;
      if (a.abstain === true) {
        out[String(pid)] = { abstain: true };
      } else {
        out[String(pid)] = {
          selection: Array.isArray(a.selection) ? a.selection : [],
        };
      }
    }
    return out;
  };

  // `nonce` is declared Number in the schema but legacy rows can be
  // non-numeric (see nonceManager.confirmedHead's $type guard), so pick
  // the latest confirmed by numeric value rather than trusting any sort.
  const toNonce = (n) => (typeof n === "number" ? n : Number(n));
  let confirmedPkg = null;

  for (const pkg of packages) {
    if (pkg.status === "hydra-confirmed") summary.confirmed++;
    else if (pkg.status === "awaiting-signatures") summary.awaitingSignatures++;
    else if (pkg.status === "awaiting-submission") summary.awaitingSubmission++;
    else if (pkg.status === "draft") summary.draft++;
    else if (pkg.status === "failed") summary.failed++;

    if (
      pkg.status === "hydra-confirmed" &&
      (!confirmedPkg || toNonce(pkg.nonce) > toNonce(confirmedPkg.nonce))
    ) {
      confirmedPkg = pkg;
    }
  }

  const confirmed = confirmedPkg
    ? {
        packageId: confirmedPkg._id.toString(),
        nonce: toNonce(confirmedPkg.nonce),
        submittedAt: confirmedPkg.confirmedAt || null,
        hydraTxId: confirmedPkg.hydraTxId || null,
        votes: extractVotes(confirmedPkg),
      }
    : null;

  // Once confirmed at nonce N, every package at nonce <= N is superseded.
  const confirmedHead = confirmed ? confirmed.nonce : -Infinity;

  const inFlight = [];
  for (const pkg of packages) {
    if (pkg.status === "hydra-confirmed") continue;
    if (pkg.status === "abandoned" || pkg.status === "cancelled") continue;
    // INVARIANT: never emit a superseded package here. The frontend
    // (broker.js mineToProposalAnnotations) overlays inFlight ON TOP OF
    // confirmed — inFlight always wins — so a stale package leaked into
    // this list rehydrates the editor with an old version. A package at
    // or below the confirmed head can never resubmit (strict nonce ===
    // currentVersion + 1), so it is not actionable and must be dropped.
    if (toNonce(pkg.nonce) <= confirmedHead) continue;

    const entry = {
      packageId: pkg._id.toString(),
      status: pkg.status,
      nonce: toNonce(pkg.nonce),
      createdAt: pkg.createdAt || null,
      votes: extractVotes(pkg),
    };
    if (pkg.nativeScript) {
      try {
        const s = multisigStatus(pkg.nativeScript, pkg.signatures || []);
        entry.multisig = {
          signaturesCollected: (pkg.signatures || []).length,
          signaturesNeeded: s.required,
          satisfied: s.satisfied,
        };
      } catch {
        // malformed nativeScript — skip the multisig hint
      }
    }
    inFlight.push(entry);
  }

  // Newest-first regardless of input order.
  inFlight.sort((a, b) => toNonce(b.nonce) - toNonce(a.nonce));

  return { confirmed, inFlight, summary };
}

router.get("/:ballotId/mine", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const packages = await VotePackage.find({
    ballotId: ballot._id,
    userId: session.userId,
  }).lean();

  return res.json({
    status: "success",
    ballotId: ballot._id.toString(),
    ...buildMineView(packages),
  });
});

async function currentPackageView(id) {
  const pkg = await VotePackage.findById(id).lean();
  return enrichPackageView(pkg);
}

/**
 * Augment a raw VotePackage doc with derived fields the frontend expects:
 *   - merkleRoot: blake2b_256 hex of JSON.stringify(signingPayload)
 *   - signingPayloadHex: utf8-hex of merkleRoot (what the voter signs)
 *   - signedPayloadJson: canonical JSON string for display
 *   - multisig: { required, eligibleKeys, outstandingKeys, satisfied } when nativeScript
 *
 * The merkleRoot is ALWAYS recomputed from the stored `signingPayload`. It is
 * NEVER seeded from `pkg.voteHash`: voteHash is the blake2b_256 of the whole
 * VoteEvidence bundle (a superset of the signing payload), so the two are
 * never equal. Serving voteHash here handed multisig cosigners the evidence
 * hash as their signing target — they then signed a message no verifier would
 * accept, and the divergent witnesses were stored and submitted anyway.
 * Exported so the invariant is unit-testable without a DB round-trip.
 */
export function enrichPackageView(pkg) {
  if (!pkg) return null;
  let merkleRoot = null;
  let signedPayloadJson = null;
  let signingPayloadHex = null;
  if (pkg.signingPayload) {
    signedPayloadJson = JSON.stringify(pkg.signingPayload);
    try {
      merkleRoot = merkleRootHex(pkg.signingPayload);
    } catch {
      merkleRoot = null;
    }
    if (merkleRoot) {
      signingPayloadHex = Buffer.from(merkleRoot, "utf8").toString("hex");
    }
  }
  let multisig = null;
  if (pkg.nativeScript) {
    try {
      multisig = multisigStatus(pkg.nativeScript, pkg.signatures || []);
    } catch {
      multisig = null;
    }
  }
  return {
    ...pkg,
    merkleRoot,
    signingPayloadHex,
    signedPayloadJson,
    multisig,
  };
}

export class PackageInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageInvariantError";
    this.code = "INVALID_PACKAGE";
  }
}

/**
 * The valid-package invariant the backend guarantees before it ever calls
 * Hydra: every stored witness verifies against the package's OWN merkleRoot
 * (recomputed from signingPayload), and the native script — or the single
 * key — is satisfied by those verified signers. This is the backstop that
 * keeps an unverifiable package off-chain even if a witness slipped past the
 * /signature gate. Pure; exported for tests. Throws PackageInvariantError.
 */
export function assertValidPackage(pkg) {
  if (!pkg?.signingPayload) throw new PackageInvariantError("package has no signingPayload");
  const root = merkleRootHex(pkg.signingPayload);
  const sigs = pkg.signatures || [];
  if (sigs.length === 0) throw new PackageInvariantError("package has no signatures");
  for (const w of sigs) {
    let v;
    try {
      v = verifyWitnessAgainstMerkleRoot(w, root);
    } catch (err) {
      throw new PackageInvariantError(`witness ${w.key || "?"}: ${err.message}`);
    }
    if (!v.ok) throw new PackageInvariantError(`witness ${w.key || "?"}: ${v.reason}`);
  }
  if (pkg.nativeScript) {
    const s = multisigStatus(pkg.nativeScript, sigs);
    if (!s.satisfied) {
      throw new PackageInvariantError("native-script threshold not satisfied by verified signers");
    }
  }
  return true;
}

/**
 * Submit a ready VotePackage to the Hydra instance. On success stores the
 * confirmation artifacts on both the VotePackage and per-proposal Vote
 * rows, commits the nonce, and transitions the package to hydra-confirmed.
 * On failure releases the nonce and marks failed.
 */
async function submitPackage(pkg, ballot) {
  try {
    // Never hand Hydra a package we can't ourselves verify. Re-assert the
    // valid-package invariant over the stored witnesses first; a failure
    // drops through to the catch below (marked failed, nonce released).
    assertValidPackage(pkg);

    pkg.status = "broker-submitted";
    await pkg.save();

    const client = await forBallot(ballot._id.toString());

    // Build Hydra's expected body shape. Hydra owns the evidence JSON,
    // merkle-proof construction, IPFS pinning, and voteHash — we send the
    // structured votes + a single `signature` envelope. For key-based
    // voters the envelope IS the single CoseWitness; for multisig we
    // attach the native script + witnesses array and leave the top-level
    // COSE fields empty (Hydra validates via validateScriptSignatures).
    const witnesses = pkg.signatures || [];
    const signature = pkg.nativeScript
      ? {
          nativeScript: pkg.nativeScript,
          witnesses,
          ...(pkg.calidusDeclaration && { calidusDeclaration: pkg.calidusDeclaration }),
        }
      : {
          ...(witnesses[0] || {}),
          ...(pkg.calidusDeclaration && { calidusDeclaration: pkg.calidusDeclaration }),
        };

    const submissionBody = {
      voterId: pkg.userId,
      ballotId: ballot._id.toString(),
      votes: pkg.signingPayload.votes,
      signature,
      nonce: pkg.nonce,
      responderRole: "Voter",
    };

    // /vote is unified on the Hydra side — auto-registers if the voter
    // isn't yet. No conditional branching needed.
    const data = await client.vote(submissionBody);

    // Hydra /vote response shape (per openapi.yaml VoteResponse):
    //   { txHash, voteHash, ipfsCid, version, tokenName, registered }
    pkg.hydraTxId = data?.txHash || data?.txId || data?.hydraTxId || null;
    pkg.ipfsCid = data?.ipfsCid || data?.evidenceCid || null;
    pkg.voteHash = data?.voteHash || pkg.voteHash;
    pkg.hydraProof = data?.proof || data?.merkleProof || null;
    pkg.confirmedAt = new Date();
    pkg.status = "hydra-confirmed";
    await pkg.save();

    await nonceManager.commit({ userId: pkg.userId, ballotId: ballot._id, nonce: pkg.nonce });
    await syncVoteRecords(pkg, ballot);

    return { ok: true };
  } catch (err) {
    pkg.status = "failed";
    pkg.failureReason =
      err instanceof HydraClientError
        ? `${err.code || err.status || "HYDRA_ERROR"}: ${err.message}`
        : err.message || "unknown";
    await pkg.save();
    await nonceManager.release({ userId: pkg.userId, ballotId: ballot._id, nonce: pkg.nonce });
    throw err;
  }
}

export default router;
