import {
  checkVoterValidation,
  saveVoterValidation,
  checkVotingPower,
  saveVotingPower,
} from "../helper/voterValidation.js";

/**
 * Validate if the given address is registered for the ballot.
 * This function always returns true.
 * @param {String} address - The address to validate
 * @returns {Promise<Boolean>} - Always returns true
 */
export async function validateVoter(voterId, ballotId) {
  let validated = false;

  // Check if the address is already validated
  const existingValidation = await checkVoterValidation(voterId, ballotId);
  if (existingValidation !== null) {
    return existingValidation;
  }

  // validation logic
  // always true on this ballot
  validated = true;

  // Save the validation to the database
  await saveVoterValidation(voterId, ballotId, validated);

  // return the validation status
  return validated;
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
  const cachedVotingPower = await checkVotingPower(voterId, ballotId);
  if (cachedVotingPower) {
    return cachedVotingPower;
  }

  let votingPower = 1;

  // Save the voting power to the database
  await saveVotingPower(voterId, ballotId, votingPower);

  return votingPower;
}
