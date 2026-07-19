// Ballot-level participation: per-group sum of voting power and
// voter count for anyone who has cast at least one vote on ANY
// proposal in the ballot. The denominator authorities use for
// thresholds like "67% of participating stake voted Yes."
//
// Sourced from VoterPowerSnapshot to match the canonical voting-power
// authority (script vs snapshot vs uploaded), then joined against
// distinct Vote.userId rows on the ballot. UserCache is the fallback
// for ballots whose snapshot collection hasn't been populated yet —
// scaffold pre-seeds VoterPowerSnapshot, but real preprod ballots
// before the violet-clever-noether cron has run will rely on this.

import mongoose from 'mongoose';
import { Vote } from '../../schema/Vote.js';
import { VoterPowerSnapshot } from '../../schema/VoterPowerSnapshot.js';
import { UserCache } from '../../schema/UserCache.js';

function asObjectId(id) {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return id;
  }
}

/**
 * Internal: given a ballot + a distinct voter list, look up each
 * voter's group + power (snapshot first, UserCache fallback) and
 * sum into the per-group response shape.
 */
async function rollupVoters(ballotIdObj, distinctUserIds) {
  if (distinctUserIds.length === 0) {
    return { totalVotingPower: {}, voterCount: {} };
  }
  const snapRows = await VoterPowerSnapshot.find({
    ballotId: ballotIdObj,
    userId: { $in: distinctUserIds },
  })
    .select('userId voterGroup votingPower')
    .lean();
  const byUserSnap = new Map(snapRows.map((r) => [r.userId, r]));
  const missing = distinctUserIds.filter((u) => !byUserSnap.has(u));
  let cacheRows = [];
  if (missing.length > 0) {
    cacheRows = await UserCache.find({
      ballotId: ballotIdObj,
      userId: { $in: missing },
    })
      .select('userId voterGroup votingPower')
      .lean();
  }
  const byUserCache = new Map(cacheRows.map((r) => [r.userId, r]));

  const totalVotingPower = {};
  const voterCount = {};
  for (const userId of distinctUserIds) {
    const r = byUserSnap.get(userId) || byUserCache.get(userId);
    if (!r) continue;
    const g = r.voterGroup || 'stake';
    totalVotingPower[g] = (totalVotingPower[g] || 0) + (Number(r.votingPower) || 0);
    voterCount[g] = (voterCount[g] || 0) + 1;
  }
  return { totalVotingPower, voterCount };
}

// "Participating" = cast at least one NON-abstain vote. A voter who
// only ever abstains is opting out of the question's outcome and
// shouldn't inflate the participation denominator. $elemMatch with
// $ne:"abstain" matches votes whose submittedVote array contains
// at least one non-abstain element — covers single-target (default,
// scale) and multi-target (ranked, budget) shapes uniformly.
//
// `excludedAt: null` honors the operator-driven soft-exclusion overlay
// on `Vote` so the participation denominator stays in lockstep with the
// filtered tally.
const NON_ABSTAIN_FILTER = {
  submittedAt: { $ne: null },
  submittedVote: { $elemMatch: { $ne: 'abstain' } },
  excludedAt: null,
};

// A vote is "pure abstain" on a proposal when its submittedVote array
// contains "abstain" and NO non-abstain element — i.e. the voter
// explicitly opted out of this question (`["abstain"]`), as opposed to
// not voting on it at all (no Vote row). `submittedVote: "abstain"`
// requires at least one "abstain"; the `$not`/`$elemMatch` clause rules
// out arrays that also carry a real selection. Honors the same
// `excludedAt: null` overlay as the pool filter.
const PURE_ABSTAIN_FILTER = {
  submittedAt: { $ne: null },
  excludedAt: null,
  $and: [
    { submittedVote: 'abstain' },
    { submittedVote: { $not: { $elemMatch: { $ne: 'abstain' } } } },
  ],
};

/**
 * Internal: distinct user ids in the ballot-wide participation pool —
 * voters who cast at least one non-abstain vote on ANY proposal.
 */
async function participationPoolUserIds(ballotIdObj) {
  return Vote.distinct('userId', {
    ballotId: ballotIdObj,
    ...NON_ABSTAIN_FILTER,
  });
}

/**
 * Compute ballot-level participation grouped by voter group.
 * Distinct voters across ANY proposal in the ballot who cast at
 * least one non-abstain vote. Each voter counted once regardless of
 * how many proposals they engaged with. Only includes groups with
 * at least one participating voter.
 *
 * @param {ObjectId|String} ballotId
 * @returns {Promise<{ totalVotingPower: Record<string, number>, voterCount: Record<string, number> }>}
 */
export async function computeBallotParticipation(ballotId) {
  const id = asObjectId(ballotId);
  const distinctUserIds = await participationPoolUserIds(id);
  return rollupVoters(id, distinctUserIds);
}

/**
 * Compute per-group count + voting power of voters who are in the
 * ballot-wide participation pool AND explicitly abstained on THIS
 * proposal (the intersection). Voters who abstained on this proposal
 * but never cast a non-abstain vote anywhere are excluded — they were
 * never in the pool, so subtracting them from the pool denominator
 * would be wrong. See schema/Result.js `participatingAbstainers`.
 *
 * @param {ObjectId|String} proposalId
 * @param {ObjectId|String} ballotId — needed for the voter-power lookup
 * @returns {Promise<{ totalVotingPower: Record<string, number>, voterCount: Record<string, number> }>}
 */
export async function computeParticipatingAbstainers(proposalId, ballotId) {
  const pid = asObjectId(proposalId);
  const bid = asObjectId(ballotId);
  const [poolUserIds, abstainerUserIds] = await Promise.all([
    participationPoolUserIds(bid),
    Vote.distinct('userId', { proposalId: pid, ...PURE_ABSTAIN_FILTER }),
  ]);
  const pool = new Set(poolUserIds);
  const intersection = abstainerUserIds.filter((u) => pool.has(u));
  return rollupVoters(bid, intersection);
}

/**
 * Compute per-proposal participation grouped by voter group.
 * Distinct voters who cast at least one vote on THIS proposal.
 * Symmetrical to computeBallotParticipation — frontends can compute
 * `proposalParticipation.voterCount[g] / ballotParticipation.voterCount[g]`
 * to get "% of ballot voters who engaged with this question."
 *
 * Distinct from result.totalVotes / resultsByGroup[g].totalVotes,
 * which can over-count when a voter casts multiple targets in a
 * single vote (budget, ranked).
 *
 * @param {ObjectId|String} proposalId
 * @param {ObjectId|String} ballotId — needed for the voter-power lookup
 * @returns {Promise<{ totalVotingPower: Record<string, number>, voterCount: Record<string, number> }>}
 */
export async function computeProposalParticipation(proposalId, ballotId) {
  const pid = asObjectId(proposalId);
  const bid = asObjectId(ballotId);
  const distinctUserIds = await Vote.distinct('userId', {
    proposalId: pid,
    ...NON_ABSTAIN_FILTER,
  });
  return rollupVoters(bid, distinctUserIds);
}
