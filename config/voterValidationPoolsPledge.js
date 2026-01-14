import {
    checkVoterValidation,
    saveVoterValidation,
    saveVotingPower,
} from "../helper/voterValidation.js";
import { Ballot } from "../schema/Ballot.js";
const API_URL = process.env.API_URL;
const API_TOKEN = process.env.API_TOKEN;
const validationCacheTime = 8; // hours

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
        const voterData = await fetch(API_URL + "/pool_info", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${API_TOKEN}`,
            },
            body: JSON.stringify({
                _pool_bech32_ids: [voterId],
            }),
        });
        if (!voterData.ok) {
            console.error("Error fetching voter data: ", voterData.statusText);
            throw new Error("Failed to fetch voter data");
        }
        const voterInfo = await voterData.json();

        // check if result is empty
        if (voterInfo.length === 0) {
            console.error("Voter not found in API: ", voterId);
            validated = false;
            await saveVoterValidation(voterId, ballotId, validated);
            await saveVotingPower(voterId, ballotId, 0);
            return validated;
        }

        // check if voter is registered
        if (voterInfo[0].pool_status === "registered") {
            console.log("Voter is registered Pool: ", voterInfo[0].pool_status);
            validated = true;
            await saveVoterValidation(voterId, ballotId, validated);
            await saveVotingPower(voterId, ballotId, voterInfo[0].live_pledge);
            return validated;
        } else {
            console.error("Voter is not registered Pool: ", voterInfo[0].pool_status);
            validated = false;
            await saveVoterValidation(voterId, ballotId, validated);
            await saveVotingPower(voterId, ballotId, 0);
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
    // Check if cache exists and is less than 8 hours old
    if (
        allowedVoterCountCache &&
        allowedVoterCountTimestamp &&
        Date.now() - allowedVoterCountTimestamp <
        1000 * 60 * 60 * validationCacheTime
    ) {
        // console.log("Using cached allowed voter count");
        return allowedVoterCountCache;
    }

    try {
        console.log("Fetching allowed voter count from API...");
        const response = await fetch(API_URL + "/pool_list?pool_status=eq.registered", {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${API_TOKEN}`,
                prefer: "count=exact",
            },
        });
        // get the total count from the response headers
        const totalCount = response.headers.get("content-range").split("/")[1];
        if (!totalCount) {
            throw new Error("Failed to fetch total count from headers");
        }
        allowedVoterCountCache = totalCount;
        allowedVoterCountTimestamp = Date.now();
        console.log("Allowed voter count: ", allowedVoterCountCache);
    } catch (error) {
        console.error("Error fetching allowed voter count: ", error);
        throw new Error("Failed to fetch allowed voter count");
    }
    return allowedVoterCountCache;
}

/**
 * Get the total pledge of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
let totalWeightCache = null;
let totalWeightTimestamp = null;
// !! NEEDS TO BE STORED IN 
// !! PROBABLY NOT POSSIBLE RIGHT NOW SINCE TOTAL POOL PLEDGE IS NOT ON KOIOS
export async function getTotalWeight() {
    // Check if cache exists and is less than 8 hours old
    if (
        totalWeightCache &&
        totalWeightTimestamp &&
        Date.now() - totalWeightTimestamp < 1000 * 60 * 60 * validationCacheTime
    ) {
        // console.log("Using cached total weight");
        return totalWeightCache;
    }
    try {
        console.log("Fetching total weight from API...");
        const response = await fetch(API_URL + "/drep_epoch_summary?limit=1", {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${API_TOKEN}`,
            },
        });
        // get the total count from the response headers
        const totals = await response.json();

        totalWeightCache = totals[0]?.amount || 0;
        totalWeightTimestamp = Date.now();
        console.log("Total weight: ", totalWeightCache);
        return;
    } catch (error) {
        console.error("Error fetching total weight: ", error);
        throw new Error("Failed to fetch total weight");
    }

    return totalWeightCache;
}
