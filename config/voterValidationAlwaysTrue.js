import {
  checkVoterValidation,
  saveVoterValidation,
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

// returns random number as the total count can't be determined on this validator
/**
 * Get the allowed voter count and cache the result.
 * @returns {Promise<Number>} - The total count of registered Voters
 */
export async function allowedVoterCount() {
  return 420;
}

// returns random number as the total weight can't be determined on this validator
/**
 * Get the total weight of all registered Voters.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
export async function getTotalWeight() {
  return 690690690;
}


