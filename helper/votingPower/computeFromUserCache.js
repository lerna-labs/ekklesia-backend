// Default per-voter voting power computation: read directly from
// UserCache. Used by:
//   - voterValidationAlwaysTrue.js (and other scripts that have no
//     network-side enumeration available)
//   - the snapshot cron (when a script's own implementation hasn't
//     diverged from "what's already cached locally")
//   - tests + scaffolds
//
// Returns the shape every voterValidationScript's `computePerVoterPower`
// must return.

import mongoose from 'mongoose';
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
 * @param {ObjectId|String} ballotId
 * @returns {Promise<Array<{ userId: string, voterGroup: string, votingPower: number }>>}
 */
export async function computeFromUserCache(ballotId) {
  if (!ballotId) return [];
  const rows = await UserCache.find({
    ballotId: asObjectId(ballotId),
    validated: true,
  })
    .select('userId voterGroup votingPower')
    .lean();
  return rows.map((r) => ({
    userId: r.userId,
    voterGroup: r.voterGroup || 'stake',
    votingPower: Number(r.votingPower) || 0,
  }));
}
