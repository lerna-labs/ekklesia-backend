import {
    checkVoterValidation,
    saveVoterValidation,
    checkVotingPower,
    saveVotingPower,
} from "../helper/voterValidation.js";
import { Ballot } from "../schema/Ballot.js";
const API_URL = process.env.API_URL;
const API_TOKEN = process.env.API_TOKEN;
const validationCacheTime = 2; // hours
const ASSET_POLICY_ID = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235"
const ASSET_NAME = "484f534b59";

/**
 * Validate if the given address is a registered drep.
 * @param {string} address - The address to validate.
 * @throws {Error} If the address is not registered.
 * @throws {Error} If the API request fails.
 * @returns {boolean} True if the address is registered, false otherwise.
 */
// !! probably move completely to cron and only run once if no entry is there
export async function validateVoter(voterId, ballotId) {
    let validated = false;

    let ballot = await Ballot.findOne({ _id: ballotId });
    // console.log("Ballot found, ballot is live?", ballot.status);

    // Check if the address is already validated
    const existingValidation = await checkVoterValidation(voterId, ballotId);

    // check if the validation is older than 8 hours
    if (
        existingValidation?.updatedAt >
        Date.now() - 1000 * 60 * 60 * validationCacheTime
    ) {
        // console.log("Using cached validation", voterId);
        return existingValidation.validated;
    } else {
        console.log("No existing validation found", voterId);
    }

    if (ballot.status !== "live") {
        console.log("Ballot is not live, skipping validation");
        if (!existingValidation) {
            validated = false;
            return validated;
        } else {
            return existingValidation.validated;
        }
    }

    try {
        console.log("Fetching voter data from API...", voterId);
        const voterData = await fetch(API_URL + "/address_assets?policy_id=eq." + ASSET_POLICY_ID, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${API_TOKEN}`,
            },
            body: JSON.stringify({
                _addresses: [voterId],
            }),
        });
        if (!voterData.ok) {
            console.error("Error fetching voter data: ", voterData.statusText);
            throw new Error("Failed to fetch voter data");
        }
        const voterWallet = await voterData.json();

        // check if result is empty
        if (voterWallet.length === 0) {
            console.error("Voter not found in API: ", voterId);
            validated = false;
            await saveVoterValidation(voterId, ballotId, validated);
            await saveVotingPower(voterId, ballotId, 0);
            return validated;
        } else {
            // console.log("Voter has asset: ", voterWallet[0]);
            validated = true;
            await saveVoterValidation(voterId, ballotId, validated);
            await saveVotingPower(voterId, ballotId, voterWallet[0].quantity);
            return validated;

        }


    } catch (error) {
        console.error("Error fetching voter data: ", error);
        throw new Error("Failed to fetch voter data");
    }
}

/**
 * Get the allowed voter count and cache the result.
 * @returns {Promise<Number>} - The total count of registered DReps
 */
let allowedVoterCountCache = null;
let allowedVoterCountTimestamp = null;
// !! NEEDS TO BE STORED IN DB
export async function allowedVoterCount() {
    return 99456
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
let totalWeightCache = null;
let totalWeightTimestamp = null;
// !! NEEDS TO BE STORED IN DB
export async function getTotalWeight() {
    return 0
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of a specific DRep
 */
export async function getWeight(voterId, ballotId) {
    return 1;
}
