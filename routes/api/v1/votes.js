// Broker-side vote endpoints for Hydra ballots (v1).
//
//   POST /api/v1/votes/:ballotId/draft
//         body: { votes: VoteSelection[], responderRole?, nativeScript?,
//                 calidusDeclaration? }
//         Reserves a nonce, stores a VotePackage in "draft"/"awaiting-
//         signatures", returns the canonical signing payload.
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
import { Vote } from "../../../schema/Vote.js";
import { checkVoterValidation, checkVotingPower } from "../../../helper/voterValidation.js";
import {
  buildDraft,
  BrokerError,
} from "../../../helper/voteBroker.js";
import {
  status as multisigStatus,
  dedupeSignatures,
  MultisigError,
} from "../../../helper/multisigCollector.js";
import { normalizeWitness, CoseWitnessError } from "../../../helper/coseWitness.js";
import { User } from "../../../schema/User.js";
import blake from "blakejs";
import * as nonceManager from "../../../helper/nonceManager.js";
import { forBallot, HydraClientError } from "../../../helper/hydraClient.js";
import { credentialHrp } from "../../../helper/voterCredential.js";
import { voteWriteLimiter } from "../../../helper/rateLimiters.js";

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
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  NONCE_STALE: "NONCE_STALE",
  HYDRA_UPSTREAM: "HYDRA_UPSTREAM",
  INTERNAL: "INTERNAL",
});

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
  const ballot = await Ballot.findById(req.params.ballotId);
  if (!ballot) {
    res.status(404).json({ status: "error", message: "Ballot not found" });
    return null;
  }
  if (ballot.source !== "hydra") {
    res.status(400).json({
      status: "error",
      message: "Ballot is not Hydra-backed; writes land via v0 archive or future versions",
    });
    return null;
  }
  return ballot;
}

// POST /:ballotId/draft
router.post("/:ballotId/draft", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const { votes, responderRole, calidusDeclaration } = req.body || {};
  let nativeScript = req.body?.nativeScript || null;
  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({ status: "error", code: ERROR_CODES.BAD_INPUT, message: "votes[] required" });
  }

  // Eligibility gate (L1 validation)
  const validated = await checkVoterValidation(session.userId, ballot._id);
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
    const draft = await buildDraft({
      ballotId: ballot._id.toString(),
      voterId: session.userId,
      credentialHrp: credentialHrp(session.userId),
      votes,
      responderRole,
    });

    const pkg = await VotePackage.create({
      ballotId: ballot._id,
      userId: session.userId,
      signingPayload: draft.signingPayload,
      nonce: draft.nonce,
      voteHash: draft.prelimVoteHash,
      nativeScript: nativeScript || null,
      calidusDeclaration: calidusDeclaration || null,
      status: nativeScript ? "awaiting-signatures" : "awaiting-signatures",
    });

    let multisig = null;
    if (nativeScript) {
      multisig = multisigStatus(nativeScript, []);
    }

    return res.status(201).json({
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

  pkg.signatures = dedupeSignatures([...(pkg.signatures || []), witness]);

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
//   inFlight    Packages still in flight (awaiting signatures,
//               awaiting submission, draft, or failed). Newest first.
//               When one of these submits successfully it REPLACES
//               the confirmed state above. UI should surface these
//               (especially multisig packages waiting on cosigner
//               signatures) and warn the voter before they create a
//               new draft that would supersede an in-flight one.
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
router.get("/:ballotId/mine", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const packages = await VotePackage.find({
    ballotId: ballot._id,
    userId: session.userId,
  })
    .sort({ nonce: -1 })
    .lean();

  const summary = {
    confirmed: 0,
    awaitingSignatures: 0,
    awaitingSubmission: 0,
    draft: 0,
    failed: 0,
  };

  // Pluck per-package vote map { proposalId: selection } from the
  // signing payload. Hydra's payload uses `questionId`; older shapes
  // sometimes had `proposalId`. Normalize either way.
  const extractVotes = (pkg) => {
    const out = {};
    for (const a of pkg.signingPayload?.votes || []) {
      const pid = a.questionId || a.proposalId;
      if (!pid) continue;
      out[String(pid)] = a.vote ?? a.choice ?? null;
    }
    return out;
  };

  let confirmed = null;
  const inFlight = [];

  for (const pkg of packages) {
    if (pkg.status === "hydra-confirmed") summary.confirmed++;
    else if (pkg.status === "awaiting-signatures") summary.awaitingSignatures++;
    else if (pkg.status === "awaiting-submission") summary.awaitingSubmission++;
    else if (pkg.status === "draft") summary.draft++;
    else if (pkg.status === "failed") summary.failed++;

    if (pkg.status === "hydra-confirmed") {
      // Latest-confirmed-wins. Packages are sorted by nonce desc, so
      // the first confirmed we see IS the latest.
      if (!confirmed) {
        confirmed = {
          packageId: pkg._id.toString(),
          nonce: pkg.nonce,
          submittedAt: pkg.confirmedAt || null,
          hydraTxId: pkg.hydraTxId || null,
          votes: extractVotes(pkg),
        };
      }
      continue;
    }

    // Anything not yet on Hydra is in flight (or failed and retryable).
    const entry = {
      packageId: pkg._id.toString(),
      status: pkg.status,
      nonce: pkg.nonce,
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

  return res.json({
    status: "success",
    ballotId: ballot._id.toString(),
    confirmed,
    inFlight,
    summary,
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
 */
function enrichPackageView(pkg) {
  if (!pkg) return null;
  let merkleRoot = pkg.voteHash || null;
  let signedPayloadJson = null;
  let signingPayloadHex = null;
  if (pkg.signingPayload) {
    signedPayloadJson = JSON.stringify(pkg.signingPayload);
    // Recompute merkleRoot deterministically from the stored payload so
    // it matches what the voter signs at /draft time. (pkg.voteHash also
    // stamps the signing target after the broker computes it; both
    // values should be identical.)
    if (!merkleRoot) {
      // Fallback only — happens if the package was created before
      // voteHash was being stamped at draft time.
      try {
        merkleRoot = Buffer.from(
          blake.blake2b(Buffer.from(signedPayloadJson, "utf8"), null, 32)
        ).toString("hex");
      } catch {
        /* ignore */
      }
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

/**
 * Submit a ready VotePackage to the Hydra instance. On success stores the
 * confirmation artifacts on both the VotePackage and per-proposal Vote
 * rows, commits the nonce, and transitions the package to hydra-confirmed.
 * On failure releases the nonce and marks failed.
 */
async function submitPackage(pkg, ballot) {
  try {
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

/**
 * Mirror Hydra-confirmed votes into the per-proposal Vote collection so the
 * legacy frontend read paths and the aggregation cron can keep working.
 */
async function syncVoteRecords(pkg, ballot) {
  for (const answer of pkg.signingPayload.votes || []) {
    const base = {
      userId: pkg.userId,
      ballotId: ballot._id,
      proposalId: answer.questionId,
      vote: answer.selection || answer.ranking || answer.weights || [],
      submittedVote: answer.selection || answer.ranking || answer.weights || [],
      submittedAt: new Date(),
      nonce: pkg.nonce,
      voteHash: pkg.voteHash,
      hydraTxId: pkg.hydraTxId,
      hydraProof: pkg.hydraProof,
      ipfsCid: pkg.ipfsCid,
      confirmedAt: pkg.confirmedAt,
      status: "hydra-confirmed",
    };
    try {
      await Vote.updateOne(
        { proposalId: answer.questionId, userId: pkg.userId },
        { $set: base },
        { upsert: true }
      );
    } catch (err) {
      // proposalId may not be a Mongo ObjectId for Hydra-native questions —
      // skip the mirror in that case; the VotePackage still holds the truth.
      console.warn(`[votes/sync] skipped mirror for ${answer.questionId}: ${err.message}`);
    }
  }
  // Nudge voting power cache on first vote.
  await checkVotingPower(pkg.userId, ballot._id).catch(() => null);
}

export default router;
