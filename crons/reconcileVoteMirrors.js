// Reconciler for hydra-confirmed VotePackages whose per-proposal Vote
// mirror is missing or incomplete.
//
// In the normal flow, routes/api/v1/votes.js submitPackage() flips a
// package to "hydra-confirmed" via pkg.save() and then calls
// syncVoteRecords() to upsert per-proposal Vote rows. Those two writes
// are NOT atomic — if the process is interrupted between them
// (nodemon reload, pm2 restart, crash, dropped connection), the
// package is permanently stuck in hydra-confirmed with no Vote rows,
// and the aggregation cron — which reads the Vote collection — never
// sees the votes. Symptom on the frontend: voter count and voting
// power for the affected ballot collapse to whatever portion mirrored
// successfully.
//
// This sweep runs from the 10-minute cron and reruns the mirror via
// the shared helper. The helper's upsert is idempotent, so the
// reconciler is safe to run alongside a freshly-submitting package.
// Re-mirroring restamps `submittedAt` to "now," which guarantees the
// next aggregateVotes() tick discovers the affected proposal in its
// 12-minute discovery window.

import { VotePackage } from '../schema/VotePackage.js';
import { Vote } from '../schema/Vote.js';
import { Ballot } from '../schema/Ballot.js';
import { syncVoteRecords } from '../helper/voteMirror.js';

/**
 * Sweep hydra-confirmed packages whose Vote mirror is incomplete.
 *
 * @returns {Promise<{scanned: number, restored: number}>}
 */
export async function reconcileVoteMirrors() {
  const confirmed = await VotePackage.find({ status: 'hydra-confirmed' })
    .select(
      'userId ballotId signingPayload voteHash hydraTxId hydraProof ipfsCid confirmedAt nonce',
    )
    .lean();

  if (confirmed.length === 0) {
    return { scanned: 0, restored: 0 };
  }

  const ballotCache = new Map();
  async function loadBallot(id) {
    const key = id.toString();
    if (!ballotCache.has(key)) {
      ballotCache.set(key, await Ballot.findById(id).lean());
    }
    return ballotCache.get(key);
  }

  let restored = 0;
  for (const pkg of confirmed) {
    const expected = pkg.signingPayload?.votes || [];
    if (expected.length === 0) continue;

    // Mongoose casts the string questionId to ObjectId via the Vote
    // schema's proposalId field. A non-hex questionId throws on cast —
    // treat that as zero existing rows and let the mirror's per-id
    // catch handle the skip.
    let existing = 0;
    try {
      existing = await Vote.countDocuments({
        userId: pkg.userId,
        ballotId: pkg.ballotId,
        proposalId: { $in: expected.map((v) => v.questionId) },
      });
    } catch {
      existing = 0;
    }

    if (existing >= expected.length) continue;

    const ballot = await loadBallot(pkg.ballotId);
    if (!ballot) {
      console.warn(
        `[reconcileVoteMirrors] missing ballot ${pkg.ballotId} for package ${pkg._id} — skipping`,
      );
      continue;
    }

    try {
      await syncVoteRecords(pkg, ballot);
      restored += 1;
      console.log(
        `[reconcileVoteMirrors] mirrored package ${pkg._id} for voter ${pkg.userId} on ballot ${pkg.ballotId} (${expected.length - existing} missing)`,
      );
    } catch (err) {
      console.error(`[reconcileVoteMirrors] mirror failed for package ${pkg._id}: ${err.message}`);
    }
  }

  if (restored > 0) {
    console.log(
      `[reconcileVoteMirrors] restored ${restored} orphaned mirror(s) from ${confirmed.length} confirmed package(s)`,
    );
  }
  return { scanned: confirmed.length, restored };
}
