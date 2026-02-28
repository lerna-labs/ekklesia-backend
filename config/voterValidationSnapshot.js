import { VoterCache } from "../schema/VoterCache.js";
/**
 * Validate if the given address is registered for the ballot in the voter cache
 * This function always returns true.
 * @param {String} address - The address to validate
 * @returns {Promise<Boolean>} - Always returns true
 */
export async function validateVoter(userId, ballotId) {
    const voter = await VoterCache.findOne({ ballotId: ballotId, userId: userId, validated: true });
    if (!voter) {
        return false;
    }
    return true;
}

/**
 * Get the allowed voter count from the voter cache
 * @returns {Promise<Number>} - The total count of registered Voters
 */
export async function allowedVoterCount(ballotId) {
    const voterCount = await VoterCache.find({ ballotId: ballotId, validated: true }).countDocuments();
    return voterCount;
}

/**
 * Get the total weight of all registered Voters a specific ballot
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
export async function getTotalWeight(ballotId) {
    const voters = await VoterCache.aggregate([
        { $match: { ballotId: ballotId, validated: true } },
        { $group: { _id: null, totalWeight: { $sum: "$votingPower" } } },
    ]);
    return voters[0]?.totalWeight || 0;
}


