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
  return 420;
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
export async function getTotalWeight() {
  return 420;
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of a specific DRep
 */
export async function getWeight(voterId, ballotId) {
  return 1;
}
