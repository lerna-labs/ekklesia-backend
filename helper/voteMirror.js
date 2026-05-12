// Mirror a hydra-confirmed VotePackage into per-proposal Vote rows.
//
// The legacy aggregation cron and v0 results endpoints read from the
// Vote collection; Hydra's broker flow writes to the VotePackage
// collection. This helper bridges the two by upserting one Vote per
// answer in the package's signingPayload.
//
// Idempotent: each Vote row is keyed by (proposalId, userId) with
// upsert: true. Re-running for the same package is safe — it will
// either confirm existing rows or back-fill missing ones with no
// duplicates.
//
// Used in:
//   1. routes/api/v1/votes.js submitPackage(), inline immediately
//      after a package transitions to "hydra-confirmed".
//   2. crons/reconcileVoteMirrors.js, which sweeps for confirmed
//      packages whose mirror is incomplete (e.g. process restart
//      between pkg.save() and the inline mirror call).

import { Vote } from "../schema/Vote.js";
import { checkVotingPower } from "./voterValidation.js";

/**
 * @param {object} pkg     Mongoose VotePackage doc OR plain object with
 *                         the same shape (cron passes .lean() output).
 * @param {object} ballot  Ballot doc/object — only ballot._id is used.
 */
export async function syncVoteRecords(pkg, ballot) {
  for (const answer of pkg.signingPayload?.votes || []) {
    // Translate Hydra v2 wire shape to the internal Vote.vote
    // sentinel: { abstain: true } → ["abstain"]; selection → selection.
    // Keeping ["abstain"] as the internal marker lets the existing
    // rollup / aggregation code keep pattern-matching on first === "abstain"
    // without a wider refactor.
    const stored = answer.abstain === true ? ["abstain"] : (answer.selection || []);
    const base = {
      userId: pkg.userId,
      ballotId: ballot._id,
      proposalId: answer.questionId,
      vote: stored,
      submittedVote: stored,
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
