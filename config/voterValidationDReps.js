import {
  checkVoterValidation,
  saveVoterValidation,
  saveVotingPower,
} from '../helper/voterValidation.js';
import { Ballot } from '../schema/Ballot.js';
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
// !! this determines the voting power of the DRep only on login and if no cache is found. for live voting power this needs to be added to a cron job.
// !! this validates registered DReps, no matter if active or not
export async function validateVoter(userId, ballotId) {
  let validated = false;

  let ballot = await Ballot.findOne({ _id: ballotId });
  // console.log("Ballot found, ballot is live?", ballot.status);

  // Check if the address is already validated
  const existingValidation = await checkVoterValidation(userId, ballotId);

  // check if the validation is older than 8 hours
  if (existingValidation?.updatedAt > Date.now() - 1000 * 60 * 60 * validationCacheTime) {
    return existingValidation.validated;
  } else {
    console.log('No existing validation found', userId);
  }

  if (ballot.status !== 'live') {
    console.log('Ballot is not live, skipping validation');
    if (!existingValidation) {
      validated = false;
      return validated;
    } else {
      return existingValidation.validated;
    }
  }

  try {
    console.log('Fetching voter data from API...', userId);
    const voterData = await fetch(API_URL + '/drep_info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        _drep_ids: [userId],
      }),
    });

    if (!voterData.ok) {
      console.error('Error fetching voter data: ', voterData.statusText);
      throw new Error('Failed to fetch voter data');
    }
    const voterInfo = await voterData.json();

    // check if result is empty
    if (voterInfo.length === 0) {
      console.log('Voter not found in API: ', userId);
      validated = false;
      await saveVoterValidation(userId, ballotId, validated, 'drep');
      await saveVotingPower(userId, ballotId, 0, 'drep');
      return validated;
    }

    // Koios `/drep_info` returns `drep_status: "registered" | "retired" | "unregistered"`.
    // Older versions returned a boolean `registered` — accept both for
    // resilience across Koios upgrades.
    const isRegistered =
      voterInfo[0].drep_status === 'registered' || voterInfo[0].registered === true;
    if (isRegistered) {
      console.log('Voter is registered DRep:', userId);
      validated = true;
      await saveVoterValidation(userId, ballotId, validated, 'drep');
      await saveVotingPower(userId, ballotId, voterInfo[0].amount, 'drep');
      return validated;
    } else {
      console.log('Voter is not a registered DRep:', userId, 'status=', voterInfo[0].drep_status);
      validated = false;
      await saveVoterValidation(userId, ballotId, validated, 'drep');
      await saveVotingPower(userId, ballotId, 0, 'drep');
      return validated;
    }
  } catch (error) {
    console.error('Error fetching voter data: ', error);
    throw new Error('Failed to fetch voter data');
  }
}

/**
 * Get the allowed voter count and cache the result.
 * @returns {Promise<Number>} - The total count of registered DReps
 */
// !! this fetches registered DReps, no matter if active or not
let allowedVoterCountCache = null;
let allowedVoterCountTimestamp = null;
export async function allowedVoterCount() {
  // Check if cache exists and is less than 8 hours old
  if (
    allowedVoterCountCache &&
    allowedVoterCountTimestamp &&
    Date.now() - allowedVoterCountTimestamp < 1000 * 60 * 60 * validationCacheTime
  ) {
    // console.log("Using cached allowed voter count");
    return allowedVoterCountCache;
  }

  try {
    console.log('Fetching allowed voter count from API...');
    const response = await fetch(API_URL + '/drep_list?registered=eq.true', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
        prefer: 'count=exact',
      },
    });
    // get the total count from the response headers
    const totalCount = response.headers.get('content-range').split('/')[1];
    if (!totalCount) {
      throw new Error('Failed to fetch total count from headers');
    }
    allowedVoterCountCache = totalCount;
    allowedVoterCountTimestamp = Date.now();
    console.log('Allowed voter count: ', allowedVoterCountCache);
  } catch (error) {
    console.error('Error fetching allowed voter count: ', error);
    throw new Error('Failed to fetch allowed voter count');
  }
  return allowedVoterCountCache;
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
let totalWeightCache = null;
let totalWeightTimestamp = null;
export async function getTotalWeight() {
  // Check if cache exists and is less than 8 hours old
  if (
    totalWeightCache &&
    totalWeightTimestamp &&
    Date.now() - totalWeightTimestamp < 1000 * 60 * 60 * validationCacheTime
  ) {
    return totalWeightCache;
  }

  try {
    console.log('Fetching total weight from API...');
    const response = await fetch(API_URL + '/drep_epoch_summary?limit=1', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
    });
    // get the total count from the response headers
    const totals = await response.json();

    totalWeightCache = totals[0]?.amount || 0;
    totalWeightTimestamp = Date.now();
    console.log('Total weight: ', totalWeightCache);
    return totalWeightCache;
  } catch (error) {
    console.error('Error fetching total weight: ', error);
    throw new Error('Failed to fetch total weight');
  }
}

// Per-voter power for snapshot/cron. Defaults to UserCache rows.
// Override here if this script can enumerate the chain better than
// the local UserCache (e.g. fetch all DReps from Koios, all pools,
// etc.) and produce per-voter rows directly.
export { computeFromUserCache as computePerVoterPower } from '../helper/votingPower/computeFromUserCache.js';
