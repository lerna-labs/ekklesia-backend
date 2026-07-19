import mongoose from 'mongoose';
import { checkVoterValidation, saveVoterValidation } from '../helper/voterValidation.js';
import { UserCache } from '../schema/UserCache.js';
import { computeFromUserCache } from '../helper/votingPower/computeFromUserCache.js';

// Per-voter power for snapshot/cron — always-true ballots have no
// upstream universe to enumerate, so UserCache is the source of truth.
export const computePerVoterPower = computeFromUserCache;

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
 * Validate if the given address is registered for the ballot.
 * This function always returns true.
 * @param {String} address - The address to validate
 * @returns {Promise<Boolean>} - Always returns true
 */
export async function validateVoter(userId, ballotId) {
  let validated = false;

  // Check if the address is already validated
  const existingValidation = await checkVoterValidation(userId, ballotId);
  if (existingValidation !== null) {
    return existingValidation;
  }

  // validation logic
  // always true on this ballot
  validated = true;

  // Save the validation to the database
  await saveVoterValidation(userId, ballotId, validated, 'default');

  // return the validation status
  return validated;
}

// alwaysTrue can't enumerate "everyone" on-chain — for real ballots
// the eligible-voter universe is unbounded. When UserCache rows exist
// for the ballot (scaffold-seeded or via prior validations) we sum
// from there so totals match the visible voters; otherwise fall back
// to the historical placeholders so legacy real-world ballots keep
// rendering (the frontend has been treating these as sentinel values).
const PLACEHOLDER_COUNT = 420;
const PLACEHOLDER_WEIGHT = 690690690;

/**
 * Total validated voters for this ballot.
 * @param {String|ObjectId} ballotId
 * @returns {Promise<Number>}
 */
export async function allowedVoterCount(ballotId) {
  if (!ballotId) return PLACEHOLDER_COUNT;
  const n = await UserCache.countDocuments({ ballotId: asObjectId(ballotId), validated: true });
  return n > 0 ? n : PLACEHOLDER_COUNT;
}

/**
 * Sum of validated voters' voting power for this ballot.
 * @param {String|ObjectId} ballotId
 * @returns {Promise<Number>}
 */
export async function getTotalWeight(ballotId) {
  if (!ballotId) return PLACEHOLDER_WEIGHT;
  const [agg] = await UserCache.aggregate([
    { $match: { ballotId: asObjectId(ballotId), validated: true } },
    { $group: { _id: null, total: { $sum: '$votingPower' } } },
  ]);
  if (agg && agg.total > 0) return agg.total;
  return PLACEHOLDER_WEIGHT;
}
