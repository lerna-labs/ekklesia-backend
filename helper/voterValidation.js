import { UserCache } from "../schema/UserCache.js";
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
 * @param {string} userId - The ID of the voter to check
 * @param {string|ObjectId} ballotId - The ID of the ballot to check against
 * @returns {Object|null} The validation record if found, null otherwise
 *
 * @description
 * Queries the UserCache collection to determine if a voter has already
 * been validated for the specified ballot. Returns the full validation
 * record if found, which includes validation status and voting power.
 */
export async function checkVoterValidation(userId, ballotId) {
  conditionalLog(
    "CACHE: Checking voter validation",
    userId,
    "ballotId:",
    ballotId.toString()
  );
  // Check if the address is already validated
  const existingValidation = await UserCache.findOne({
    ballotId,
    userId,
  }).lean();
  if (!existingValidation) {
    conditionalLog(
      "CACHE: No validation found",
      userId,
      "ballotId:",
      ballotId.toString()
    );
    return null;
  } else {
    conditionalLog(
      "CACHE: Found validation",
      userId,
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
 * @param {string} userId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @param {boolean} validated - The validation status to save
 * @param {string} [voterGroup] - Optional group for this voter on this ballot (e.g. "drep", "pool", "default")
 * @returns {Promise<Object>} The updated or created validation document
 * @throws {Error} If validation cannot be saved
 *
 * @description
 * Creates or updates a validation record in the UserCache collection.
 * Uses findOneAndUpdate with upsert to either create a new record or
 * update an existing one, depending on whether a record already exists.
 */
export async function saveVoterValidation(userId, ballotId, validated, voterGroup) {
  const update = { validated, ballotId, userId };
  if (voterGroup !== undefined) update.voterGroup = voterGroup;
  // Save the validation to the database
  const newValidation = await UserCache.findOneAndUpdate(
    { ballotId, userId },
    update,
    { upsert: true, new: true }
  );
  if (!newValidation) {
    throw new Error("CACHE: Failed to save validation");
  }
  // Log the saved validation
  conditionalLog(
    "CACHE: Voter validation saved for",
    userId,
    ballotId.toString(),
    validated
  );
}

/**
 * Checks and retrieves the voting power from voter cache if available
 *
 * @param {string} userId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @returns {number|boolean} The voting power if found, false otherwise
 *
 * @description
 * Queries the UserCache collection to retrieve a voter's voting power
 * for the specified ballot. Returns the voting power value if found,
 * or false if no record exists or voting power hasn't been set.
 */
export async function checkVotingPower(userId, ballotId) {
  conditionalLog(
    "CACHE: Checking voting power for",
    userId,
    "ballotId:",
    ballotId.toString()
  );
  // Check if the address is already validated
  const existingValidation = await UserCache.findOne({
    ballotId,
    userId,
  }).lean();
  conditionalLog("Existing validation found", existingValidation);
  if (!existingValidation) {
    conditionalLog(
      "CACHE: No voting power found for",
      userId,
      ballotId.toString()
    );
    return false;
  } else {
    conditionalLog(
      "CACHE: Found voting power for",
      userId,
      ballotId.toString(),
      existingValidation.votingPower
    );
    return existingValidation.votingPower;
  }
}

/**
 * Saves the voting power of a voter for a specific ballot
 *
 * @param {string} userId - The ID of the voter
 * @param {string|ObjectId} ballotId - The ID of the ballot
 * @param {number} votingPower - The voting power to save
 * @param {string} [voterGroup] - Optional group for this voter on this ballot
 * @returns {Promise<Object>} The updated validation document
 * @throws {Error} If voting power cannot be saved
 *
 * @description
 * Updates an existing voter validation record with voting power.
 * This function does not create a new record if none exists (upsert: false),
 * so saveVoterValidation should be called first for new voters.
 */
export async function saveVotingPower(userId, ballotId, votingPower, voterGroup) {
  conditionalLog(
    "CACHE: Saving voting power for",
    userId,
    ballotId.toString(),
    votingPower
  );
  const update = { votingPower };
  if (voterGroup !== undefined) update.voterGroup = voterGroup;
  // Save the validation to the database
  const newValidation = await UserCache.findOneAndUpdate(
    { ballotId, userId },
    update,
    { upsert: false, new: true }
  );
  if (!newValidation) {
    throw new Error("CACHE: Failed to save votingPower");
  }
  // Log the saved validation
  conditionalLog(
    "CACHE Voter validation saved for",
    userId,
    ballotId.toString(),
    votingPower
  );
}
