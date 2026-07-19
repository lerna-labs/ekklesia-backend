import {
  checkVoterValidation,
  saveVoterValidation,
  saveVotingPower,
} from '../helper/voterValidation.js';
import { Ballot } from '../schema/Ballot.js';
import { UserCache } from '../schema/UserCache.js';
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
export async function validateVoter(userId, ballotId) {
  let validated = false;

  let ballot = await Ballot.findOne({ _id: ballotId });
  // console.log("Ballot found, ballot is live?", ballot.status);

  // Check if the address is already validated
  const existingValidation = await checkVoterValidation(userId, ballotId);

  // check if the validation is older than 8 hours
  if (existingValidation?.updatedAt > Date.now() - 1000 * 60 * 60 * validationCacheTime) {
    // console.log("Using cached validation", userId);
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
    const voterData = await fetch(API_URL + '/pool_info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        _pool_bech32_ids: [userId],
      }),
    });
    if (!voterData.ok) {
      console.error('Error fetching voter data: ', voterData.statusText);
      throw new Error('Failed to fetch voter data');
    }
    const voterInfo = await voterData.json();

    // check if result is empty
    if (voterInfo.length === 0) {
      console.error('Voter not found in API: ', userId);
      validated = false;
      await saveVoterValidation(userId, ballotId, validated, 'pool');
      await saveVotingPower(userId, ballotId, 0, 'pool');
      return validated;
    }

    // check if pool is registered
    if (voterInfo[0].pool_status === 'registered') {
      console.log('Voter is registered Pool: ', voterInfo[0].pool_status);
      // BigInt for safe numeric compare on large lovelace values.
      const livePledge = BigInt(voterInfo[0].live_pledge || '0');
      const pledge = BigInt(voterInfo[0].pledge || '0');

      // Zero-pledge case: pools that registered with `pledge: 0`
      // are valid pools — they just contribute 0 weight under
      // pledge-based voting. Distinguish from "not found" (which
      // already returned above) so the frontend can show "found
      // but ineligible by weight" rather than treating them as
      // absent.
      if (pledge === 0n) {
        validated = true;
        await saveVoterValidation(userId, ballotId, validated, 'pool');
        await saveVotingPower(userId, ballotId, '0', 'pool');
        console.log('Pool has 0 pledge — accepting with 0 weight');
        return validated;
      }
      if (livePledge >= pledge) {
        validated = true;
        await saveVoterValidation(userId, ballotId, validated, 'pool');
        await saveVotingPower(userId, ballotId, voterInfo[0].live_pledge, 'pool');
        return validated;
      } else {
        console.log(
          'Voter live pledge is smaller than pledge: ',
          voterInfo[0].live_pledge,
          voterInfo[0].pledge,
        );
        validated = false;
        await saveVoterValidation(userId, ballotId, validated, 'pool');
        await saveVotingPower(userId, ballotId, 0, 'pool');
        return validated;
      }
    } else {
      console.log('Voter is not registered Pool: ', voterInfo[0].pool_status);
      validated = false;
      await saveVoterValidation(userId, ballotId, validated, 'pool');
      await saveVotingPower(userId, ballotId, 0, 'pool');
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
let allowedVoterCountCache = null;
let allowedVoterCountTimestamp = null;
// !! requests the allowed voter count from the voter cache - this will only work if a cronjob updates the voter cache to reflect snapshot or on-chain data
export async function allowedVoterCount(ballotId) {
  // Check if cache exists and is less than 8 hours old
  if (
    allowedVoterCountCache &&
    allowedVoterCountTimestamp &&
    Date.now() - allowedVoterCountTimestamp < 1000 * 60 * 60 * validationCacheTime
  ) {
    return allowedVoterCountCache;
  }

  try {
    console.log('Fetching allowed voter count from Voter Cache...');
    const voterCount = await UserCache.find({
      ballotId: ballotId,
      validated: true,
    }).countDocuments();
    allowedVoterCountCache = voterCount;
    allowedVoterCountTimestamp = Date.now();
    console.log('Allowed voter count: ', allowedVoterCountCache);
  } catch (error) {
    console.error('Error fetching allowed voter count: ', error);
    throw new Error('Failed to fetch allowed voter count');
  }
  return allowedVoterCountCache;
}

/**
 * Get the total valid pledge of all registered Pools.
 * @returns {Promise<Number>} - The total weight of registered Pools
 */
let totalWeightCache = null;
let totalWeightTimestamp = null;
// !! requests the allowed voter count from the voter cache - this will only work if a cronjob updates the voter cache to reflect snapshot or on-chain data
export async function getTotalWeight(ballotId) {
  // Check if cache exists and is less than 8 hours old
  if (
    totalWeightCache &&
    totalWeightTimestamp &&
    Date.now() - totalWeightTimestamp < 1000 * 60 * 60 * validationCacheTime
  ) {
    return totalWeightCache;
  }
  try {
    console.log('Fetching total weight from Voter Cache...');
    const voters = await UserCache.aggregate([
      { $match: { ballotId: ballotId, validated: true } },
      { $group: { _id: null, totalWeight: { $sum: '$votingPower' } } },
    ]);
    totalWeightCache = voters[0]?.totalWeight || 0;
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
