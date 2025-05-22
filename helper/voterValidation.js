import { VoterCache } from "../schema/VoterCache.js";
let showConsole = false;

/**
 * Helper function to conditionally log messages based on debug flag
 *
 * @param {...any} args - Arguments to pass to console.log
 * @returns {void}
 *
 * @description
 * Only logs messages when showConsole is true, allowing for easy toggling
 * of debug output without modifying code throughout the file
 */
function conditionalLog(...args) {
  if (showConsole) {
    console.log(...args);
  }
}

/**
 * Checks if a voter has already been validated for a specific ballot
 *
 * @param {string} voterId - The ID of the voter to check
 * @param {string|ObjectId} ballotId - The ID of the ballot to check against
 * @returns {Object|null} The validation record if found, null otherwise
 *
 * @description
 * Queries the VoterCache collection to determine if a voter has already
 * been validated for the specified ballot. Returns the full validation
 * record if found, which includes validation status and voting power.
 */
export async function checkVoterValidation(voterId, ballotId) {
  conditionalLog(
    "CACHE: Checking voter validation",
    voterId,
    "ballotId:",
    ballotId.toString()
  );
  // Check if the address is already validated
  const existingValidation = await VoterCache.findOne({
    ballotId,
    voterId,
  }).lean();
  if (!existingValidation) {
    conditionalLog(
      "CACHE: No validation found",
      voterId,
      "ballotId:",
      ballotId.toString()
    );
    return null;
  } else {
    conditionalLog(
      "CACHE: Found validation",
      voterId,
      "ballotId:",
      ballotId.toString(),
      "validated:",
      existingValidation.validated
    );
    return existingValidation;
  }
}

/**
 * Saves the validation status of a voter for a specific ballot
 *
 * @param {string} voterId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @param {boolean} validated - The validation status to save
 * @returns {Promise<Object>} The updated or created validation document
 * @throws {Error} If validation cannot be saved
 *
 * @description
 * Creates or updates a validation record in the VoterCache collection.
 * Uses findOneAndUpdate with upsert to either create a new record or
 * update an existing one, depending on whether a record already exists.
 */
export async function saveVoterValidation(voterId, ballotId, validated) {
  // Save the validation to the database
  const newValidation = await VoterCache.findOneAndUpdate(
    { ballotId, voterId },
    { validated, ballotId, voterId },
    { upsert: true, new: true }
  );
  if (!newValidation) {
    throw new Error("CACHE: Failed to save validation");
  }
  // Log the saved validation
  conditionalLog(
    "CACHE: Voter validation saved for",
    voterId,
    ballotId.toString(),
    validated
  );
}

/**
 * Checks and retrieves the voting power from voter cache if available
 *
 * @param {string} voterId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @returns {number|boolean} The voting power if found, false otherwise
 *
 * @description
 * Queries the VoterCache collection to retrieve a voter's voting power
 * for the specified ballot. Returns the voting power value if found,
 * or false if no record exists or voting power hasn't been set.
 */
export async function checkVotingPower(voterId, ballotId) {
  conditionalLog(
    "CACHE: Checking voting power for",
    voterId,
    "ballotId:",
    ballotId.toString()
  );
  // Check if the address is already validated
  const existingValidation = await VoterCache.findOne({
    ballotId,
    voterId,
  }).lean();
  conditionalLog("Existing validation found", existingValidation);
  if (!existingValidation) {
    conditionalLog(
      "CACHE: No voting power found for",
      voterId,
      ballotId.toString()
    );
    return false;
  } else {
    conditionalLog(
      "CACHE: Found voting power for",
      voterId,
      ballotId.toString(),
      existingValidation.votingPower
    );
    return existingValidation.votingPower;
  }
}

/**
 * Saves the voting power of a voter for a specific ballot
 *
 * @param {string} voterId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @param {number} votingPower - The voting power to save
 * @returns {Promise<Object>} The updated validation document
 * @throws {Error} If voting power cannot be saved
 *
 * @description
 * Updates an existing voter validation record with voting power.
 * This function does not create a new record if none exists (upsert: false),
 * so saveVoterValidation should be called first for new voters.
 */
export async function saveVotingPower(voterId, ballotId, votingPower) {
  conditionalLog(
    "CACHE: Saving voting power for",
    voterId,
    ballotId.toString(),
    votingPower
  );
  // Save the validation to the database
  const newValidation = await VoterCache.findOneAndUpdate(
    { ballotId, voterId },
    { votingPower },
    { upsert: false, new: true }
  );
  if (!newValidation) {
    throw new Error("CACHE: Failed to save votingPower");
  }
  // Log the saved validation
  conditionalLog(
    "CACHE Voter validation saved for",
    voterId,
    ballotId.toString(),
    votingPower
  );
}
