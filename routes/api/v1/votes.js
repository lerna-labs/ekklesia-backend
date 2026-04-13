// Broker-side vote endpoints for Hydra ballots (v1).
//
//   POST /api/v1/votes/:ballotId/draft
//         body: { votes: VoteSelection[], responderRole?, nativeScript?,
//                 calidusDeclaration? }
//         Reserves a nonce, stores a VotePackage in "draft"/"awaiting-
//         signatures", returns the canonical signing payload.
//
//   POST /api/v1/votes/:ballotId/signature
//         body: { packageId, witness: { key, coseSign1Hex, coseKeyHex, signature } }
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
  finalizeEvidence,
  BrokerError,
} from "../../../helper/voteBroker.js";
import {
  status as multisigStatus,
  dedupeSignatures,
  MultisigError,
} from "../../../helper/multisigCollector.js";
import * as nonceManager from "../../../helper/nonceManager.js";
import { forBallot, HydraClientError } from "../../../helper/hydraClient.js";
import { credentialHrp } from "../../../helper/voterCredential.js";

const router = Router();

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

  const { votes, responderRole, nativeScript, calidusDeclaration } = req.body || {};
  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({ status: "error", message: "votes[] required" });
  }

  // Eligibility gate (L1 validation)
  const validated = await checkVoterValidation(session.userId, ballot._id);
  if (!validated) {
    return res.status(403).json({ status: "error", message: "Voter is not eligible for this ballot" });
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
      prelimVoteHash: draft.prelimVoteHash,
      multisig,
    });
  } catch (err) {
    if (err instanceof BrokerError) {
      return res.status(400).json({ status: "error", code: err.code, message: err.message });
    }
    console.error("[votes/draft] error:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// POST /:ballotId/signature
router.post("/:ballotId/signature", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ballot = await requireHydraBallot(req, res);
  if (!ballot) return;

  const { packageId, witness } = req.body || {};
  if (!packageId || !witness) {
    return res.status(400).json({ status: "error", message: "packageId and witness required" });
  }

  const pkg = await VotePackage.findOne({ _id: packageId, ballotId: ballot._id });
  if (!pkg) return res.status(404).json({ status: "error", message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", message: "Not the package owner" });
  }
  if (!["draft", "awaiting-signatures"].includes(pkg.status)) {
    return res.status(409).json({ status: "error", message: `Package in terminal state: ${pkg.status}` });
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
  if (!pkg) return res.status(404).json({ status: "error", message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", message: "Not the package owner" });
  }
  if (pkg.status === "hydra-confirmed") {
    return res.json({ status: "success", package: await currentPackageView(pkg._id) });
  }
  if (pkg.status !== "awaiting-submission") {
    return res.status(409).json({ status: "error", message: `Package in state ${pkg.status}` });
  }

  const result = await submitPackage(pkg, ballot).catch((err) => ({ ok: false, err }));
  if (!result.ok) {
    return res.status(502).json({
      status: "error",
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
  if (!pkg) return res.status(404).json({ status: "error", message: "Package not found" });
  if (pkg.userId !== session.userId) {
    return res.status(403).json({ status: "error", message: "Not the package owner" });
  }
  return res.json({ status: "success", package: pkg });
});

async function currentPackageView(id) {
  return VotePackage.findById(id).lean();
}

/**
 * Submit a ready VotePackage to the Hydra instance. On success stores the
 * confirmation artifacts on both the VotePackage and per-proposal Vote
 * rows, commits the nonce, and transitions the package to hydra-confirmed.
 * On failure releases the nonce and marks failed.
 */
async function submitPackage(pkg, ballot) {
  try {
    const { evidence, voteHash } = finalizeEvidence(
      // Reconstruct the evidence skeleton from stored payload.
      {
        specVersion: "ekklesia/1.0",
        surveyTxId: ballot._id.toString(),
        responderRole: "Voter",
        answers: pkg.signingPayload.votes,
        ekklesia: {
          voterId: pkg.userId,
          credentialHrp: credentialHrp(pkg.userId),
          nonce: pkg.nonce,
          signedPayload: pkg.signingPayload,
          witnesses: [],
          merkleProof: pkg.merkleProof || { root: "", steps: [] },
        },
      },
      {
        witnesses: pkg.signatures,
        nativeScript: pkg.nativeScript,
        calidusDeclaration: pkg.calidusDeclaration,
      }
    );

    pkg.status = "broker-submitted";
    pkg.voteHash = voteHash;
    await pkg.save();

    const client = await forBallot(ballot._id.toString());
    const submissionBody = {
      voterId: pkg.userId,
      ballotId: ballot._id.toString(),
      evidence,
      signatures: pkg.signatures,
      nativeScript: pkg.nativeScript,
      calidusDeclaration: pkg.calidusDeclaration,
      nonce: pkg.nonce,
    };

    // Choose between /vote and /vote-and-register by peek: register-if-needed
    // is owned by Hydra already, so /vote covers both cases when the instance
    // supports upsert semantics. Most Hydra deployments expose both; pick
    // based on whether the voter has a prior nonce.
    const data = pkg.nonce === 1 ? await client.voteAndRegister(submissionBody) : await client.vote(submissionBody);

    pkg.hydraTxId = data?.txId || data?.hydraTxId || null;
    pkg.ipfsCid = data?.ipfsCid || null;
    pkg.hydraProof = data?.proof || null;
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
