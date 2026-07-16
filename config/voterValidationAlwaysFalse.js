/**
 * Validate if the given address is registered for the ballot.
 * This function always returns false.
 * @param {String} address - The address to validate
 * @returns {Promise<Boolean>} - Always returns true
 */
export async function validateVoter(signerAddress) {
  return false;
}

/**
 * Get the allowed voter count and cache the result.
 * @returns {Promise<Number>} - The total count of registered DReps
 */
export async function allowedVoterCount() {
  return 0;
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
export async function getTotalWeight() {
  return 0;
}

// Per-voter power for snapshot/cron. Defaults to UserCache rows.
// Override here if this script can enumerate the chain better than
// the local UserCache (e.g. fetch all DReps from Koios, all pools,
// etc.) and produce per-voter rows directly.
export { computeFromUserCache as computePerVoterPower } from '../helper/votingPower/computeFromUserCache.js';
