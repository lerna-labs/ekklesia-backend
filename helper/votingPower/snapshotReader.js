// Snapshot reader — central read path for ballot voting-power totals.
//
// Honors Ballot.votingPowerSource:
//
//   "script"    — call the script's computePerVoterPower(ballotId) on
//                 every read. Don't persist. Use only for ballots that
//                 explicitly opt in to live computation.
//   "snapshot"  — read VoterPowerSnapshot rows. If none exist (e.g.
//                 cron hasn't run yet), fall back to a one-shot live
//                 computation so the response isn't empty.
//   "uploaded"  — read VoterPowerSnapshot rows. Never call the script.
//                 If no rows exist (shouldn't happen — upload always
//                 writes), return zeros.
//
// Aggregates per-voter rows into the per-group response shape consumed
// by routes/api/v0/ballots.js, the v1 unified adapter, and (via a
// Vote ⨝ UserCache cross-reference) Active Voting Power.

import mongoose from "mongoose";
import { VoterPowerSnapshot } from "../../schema/VoterPowerSnapshot.js";
import { Vote } from "../../schema/Vote.js";
import { loadValidationScript } from "../loadValidationScript.js";

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
 * Aggregate per-voter rows into the per-group response object.
 * Only includes groups that have at least one voter (per user
 * direction — frontends infer presence from key existence).
 *
 * @param {Array<{voterGroup: string, votingPower: number}>} rows
 * @returns {{ totalVotingPower: object, eligibleVoterCount: object }}
 */
function rollupByGroup(rows) {
  const totalVotingPower = {};
  const eligibleVoterCount = {};
  for (const r of rows) {
    const g = r.voterGroup || "default";
    totalVotingPower[g] = (totalVotingPower[g] || 0) + (Number(r.votingPower) || 0);
    eligibleVoterCount[g] = (eligibleVoterCount[g] || 0) + 1;
  }
  return { totalVotingPower, eligibleVoterCount };
}

/**
 * Compute Active Voting Power per group: sum of per-voter power for
 * voters who have at least one Vote doc on this ballot. Cheap enough
 * to recompute per request. Keyed off `(ballotId, userId)` join with
 * VoterPowerSnapshot — same source of truth.
 *
 * @param {ObjectId|String} ballotId
 * @returns {Promise<{ activeVotingPower: object, activeVoterCount: object }>}
 */
async function computeActive(ballotId) {
  const id = asObjectId(ballotId);
  const agg = await Vote.aggregate([
    { $match: { ballotId: id, submittedAt: { $ne: null } } },
    { $group: { _id: "$userId" } },
    {
      $lookup: {
        from: "voterpowersnapshots",
        let: { uid: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$ballotId", id] },
                  { $eq: ["$userId", "$$uid"] },
                ],
              },
            },
          },
        ],
        as: "snap",
      },
    },
    { $unwind: { path: "$snap", preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: "$snap.voterGroup",
        votingPower: { $sum: "$snap.votingPower" },
        voterCount: { $sum: 1 },
      },
    },
  ]);

  const activeVotingPower = {};
  const activeVoterCount = {};
  for (const row of agg) {
    activeVotingPower[row._id || "default"] = row.votingPower || 0;
    activeVoterCount[row._id || "default"] = row.voterCount || 0;
  }
  return { activeVotingPower, activeVoterCount };
}

/**
 * Read snapshot rows for a ballot, falling back to a one-shot live
 * computation when none exist. Returns the raw row array — caller is
 * responsible for rolling up.
 */
async function readOrFallback(ballot) {
  const id = asObjectId(ballot._id);
  const rows = await VoterPowerSnapshot.find({ ballotId: id })
    .select("userId voterGroup votingPower source")
    .lean();
  if (rows.length > 0) return rows;

  // Fallback only meaningful for source === "snapshot" (cron hasn't
  // run yet) or source === "script" (always fresh). For "uploaded"
  // the absence of rows means the upload was empty or something is
  // wrong — return empty rather than silently calling a script.
  const sourceType = ballot.votingPowerSource?.type || "snapshot";
  if (sourceType === "uploaded") return [];

  const scriptName = ballot.votingPowerSource?.scriptName || ballot.voterValidationScript;
  if (!scriptName) return [];
  try {
    const mod = await loadValidationScript(scriptName);
    if (typeof mod.computePerVoterPower !== "function") return [];
    const live = await mod.computePerVoterPower(ballot._id);
    return Array.isArray(live) ? live : [];
  } catch (err) {
    console.warn(
      `[snapshotReader] live fallback failed for ${ballot._id} (${scriptName}): ${err.message}`
    );
    return [];
  }
}

/**
 * Build the per-group response shape for a ballot.
 *
 * @param {Object} ballot — the Ballot document (lean ok)
 * @returns {Promise<{
 *   totalVotingPower: Record<string, number>,
 *   eligibleVoterCount: Record<string, number>,
 *   activeVotingPower: Record<string, number>,
 *   activeVoterCount: Record<string, number>,
 *   votingPowerSource: { type: string, scriptName: string|null,
 *                        uploadedAt: Date|null, uploadedBy: string|null },
 * }>}
 */
export async function readBallotPower(ballot) {
  const rows = await readOrFallback(ballot);
  const { totalVotingPower, eligibleVoterCount } = rollupByGroup(rows);
  const { activeVotingPower, activeVoterCount } = await computeActive(ballot._id);

  const src = ballot.votingPowerSource || { type: "snapshot" };
  return {
    totalVotingPower,
    eligibleVoterCount,
    activeVotingPower,
    activeVoterCount,
    votingPowerSource: {
      type: src.type || "snapshot",
      scriptName: src.scriptName || null,
      uploadedAt: src.uploadedAt || null,
      uploadedBy: src.uploadedBy || null,
    },
  };
}

/**
 * Convenience: compute the degenerate scalar sums kept for
 * backward-compat during the deprecation window.
 */
export function scalarTotals(perGroup) {
  let totalVotingPower = 0;
  let totalAllowedVoterCount = 0;
  for (const v of Object.values(perGroup.totalVotingPower)) totalVotingPower += v;
  for (const v of Object.values(perGroup.eligibleVoterCount)) totalAllowedVoterCount += v;
  return { totalVotingPower, totalAllowedVoterCount };
}
