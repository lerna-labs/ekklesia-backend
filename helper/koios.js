/**
 * Koios API Helper Module
 * 
 * This module provides utility functions for interacting with the Koios API,
 * a Cardano blockchain data provider. It handles fetching script information
 * and pool calidus keys for voting purposes.
 */

import { ScriptHash } from "@emurgo/cardano-serialization-lib-nodejs";

// Koios API configuration from environment variables
const API_URL = process.env.API_URL;
const API_TOKEN = process.env.API_TOKEN;


/**
 * Fetches script information from the Koios API for a given script hash.
 * 
 * This function validates the script hash format, makes an authenticated request
 * to the Koios API's script_info endpoint, and returns the script data if found.
 * 
 * @param {string} scriptHash - The hexadecimal script hash to look up
 * @returns {Promise<Object|false>} The script data object if found, false otherwise
 * @throws {Error} If API_URL or API_TOKEN are not set, or if scriptHash is invalid
 * 
 * @example
 * const scriptData = await getScript("abc123...");
 * if (scriptData) {
 *   console.log("Script found:", scriptData);
 * }
 */
export async function getScript(scriptHash) {
  const API_URL = process.env.API_URL;
  const API_TOKEN = process.env.API_TOKEN;

  // Validate that API configuration is set
  if (!API_URL) {
    console.error("API_URL is not set in the environment variables.");
    throw new Error("API URL is not set!");
  }

  if (!API_TOKEN) {
    console.error("API_TOKEN is not set in the environment variables.");
    throw new Error("API Token is not set!");
  }

  // Validate and parse the script hash format
  let script_hash;
  try {
    script_hash = ScriptHash.from_hex(scriptHash);
  } catch (error) {
    console.error(`Not a valid script hash: ${script_hash}`);
    throw new Error("Not a valid script hash");
  }

  try {
    // Make authenticated POST request to Koios script_info endpoint
    const scripts = await fetch(API_URL + "/script_info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "count=exact", // Request exact count in response headers
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({ _script_hashes: [scriptHash] }),
    });

    const script_data = await scripts.json();
    // TODO: Cache the fetched/returned script data so we can save on calls to Koios in the future

    // Return the first script if any results were found
    if (script_data.length > 0) {
      return script_data[0];
    }
    return false;
  } catch (error) {
    // Log error but don't throw - return false to indicate failure
    console.log("Error fetching script hash:", scriptHash);
    console.error(error);
  }

  return false;
}

/**
 * Fetches calidus keys for a Cardano stake pool.
 * 
 * This function retrieves calidus keys (authentication keys) for a pool identified
 * by its Bech32-encoded pool ID. These keys are used for pool authentication and
 * voting purposes. Note: This will return calidus keys for retired pools which
 * can be used to login to the system and vote, but pool votes will have a voting
 * power of 0.
 * 
 * @param {string} poolIdBech32 - The Bech32-encoded pool ID (e.g., "pool1...")
 * @returns {Promise<Object|false>} The pool calidus keys object if found, false otherwise
 * 
 * @example
 * const calidusKeys = await getCalidusKey("pool1abc123...");
 * if (calidusKeys) {
 *   console.log("Calidus keys found:", calidusKeys);
 * }
 */
export async function getCalidusKey(poolIdBech32) {
  try {
    // Query Koios API for pool calidus keys using pool ID filter
    const requestPoolCalidusKeys = await fetch(`${API_URL}/pool_calidus_keys?pool_id_bech32=eq.${poolIdBech32}`, {
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
    })
    const poolCalidusKeysBody = await requestPoolCalidusKeys.json();

    // Return the first result if any keys were found
    if (poolCalidusKeysBody.length > 0) {
      return poolCalidusKeysBody[0];
    } else {
      return false;
    }
  } catch (error) {
    // Log error and return false to indicate failure
    console.error("Error fetching pool calidus keys:", error);
    return false;
  }
}


/**
 * Fetches all registered pools from the Koios API and calculates aggregate totals.
 * 
 * This function performs paginated requests to retrieve all registered pools,
 * fetches detailed pool information, and calculates totals for:
 * - live_pledge: Current active pledge amount
 * - pledge: Declared pledge amount
 * - voting_power: Total voting power
 * - active_stake: Current active stake
 * 
 * @returns {Promise<Object>} An object containing:
 *   - poolsData: Array of all pool data objects
 *   - totalLivePledge: Sum of all live_pledge values (as string)
 *   - totalVotingPower: Sum of all voting_power values (as string)
 *   - totalActiveStake: Sum of all active_stake values (as string)
 *   - error: Error message if the operation fails
 * 
 * @example
 * const result = await getPoolTotals();
 * if (result.error) {
 *   console.error(result.error);
 * } else {
 *   console.log(`Total pools: ${result.poolsData.length}`);
 *   console.log(`Total live pledge: ${result.totalLivePledge}`);
 * }
 */
export async function getPoolTotals() {
  let poolData = [];
  console.log("Fetching pool totals...");

  // Pagination setup: fetch pools in batches of 50
  let page = 1;
  const limit = 50;
  let offset = (page - 1) * limit;
  let totalCount = 0;

  // Step 1: Get total count of registered pools from API
  // This is used to determine how many pages we need to fetch
  try {
    const requestTotalCount = await fetch(`${process.env.API_URL}/pool_list?pool_status=eq.registered&select=pool_status,pool_id_bech32&limit=1`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${process.env.API_TOKEN}`,
        prefer: "count=exact", // Request exact count in response headers
      },
    });
    // Extract total count from Content-Range header (format: "0-0/1234")
    totalCount = requestTotalCount.headers.get("content-range").split("/")[1];
    console.log(`Total pools: ${totalCount}`);
  } catch (error) {
    console.error(`Error fetching total count of pools: ${error.message}`);
    return { error: `Error fetching total count of pools: ${error.message}` };
  }

  // Step 2: Fetch all pools in paginated batches
  // Loop through pages until we've fetched all pools
  while (offset < totalCount) {
    try {
      console.log(`Fetching page ${page}/${Math.ceil(totalCount / limit)}`);

      // First, get the list of pool IDs for this page
      const requestPoolList = await fetch(`${process.env.API_URL}/pool_list?pool_status=eq.registered&select=pool_id_bech32,pool_status&offset=${offset}&limit=${limit}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${process.env.API_TOKEN}`,
          prefer: "count=exact",
        },
      });
      const pools = await requestPoolList.json();

      // Then, fetch detailed information for all pools in this batch
      // Using POST to send array of pool IDs in the request body
      const requestPoolData = await fetch(`${process.env.API_URL}/pool_info?select=pool_id_bech32,pledge,live_pledge,voting_power,active_stake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${process.env.API_TOKEN}`,
        },
        body: JSON.stringify({
          _pool_bech32_ids: pools.map(pool => pool.pool_id_bech32),
        }),
      });

      const poolDataJSON = await requestPoolData.json();
      poolData.push(...poolDataJSON);

      // Move to next page
      page++;
      offset = (page - 1) * limit;
    } catch (error) {
      console.error(`Error fetching pool data: ${error.message}`);
      return { error: `Error fetching pool data: ${error.message}` };
    }
  }

  console.log(`Fetched ${poolData.length} pools`);

  // Step 3: Calculate aggregate totals using BigInt for large number precision
  // Convert all values to BigInt to handle large Cardano lovelace amounts correctly

  // Sum all live_pledge values (current active pledge)
  const totalLivePledge = poolData.reduce((acc, pool) => {
    const livePledge = typeof pool.live_pledge === 'string' ? BigInt(pool.live_pledge) : BigInt(pool.live_pledge || 0);
    return acc + livePledge;
  }, BigInt(0));

  // Sum all pledge values (declared pledge amount)
  const totalPledge = poolData.reduce((acc, pool) => {
    const pledge = typeof pool.pledge === 'string' ? BigInt(pool.pledge) : BigInt(pool.pledge || 0);
    return acc + pledge;
  }, BigInt(0));

  // Sum all voting_power values
  const totalVotingPower = poolData.reduce((acc, pool) => {
    const votingPower = typeof pool.voting_power === 'string' ? BigInt(pool.voting_power) : BigInt(pool.voting_power || 0);
    return acc + votingPower;
  }, BigInt(0));

  // Sum all active_stake values
  const totalActiveStake = poolData.reduce((acc, pool) => {
    const activeStake = typeof pool.active_stake === 'string' ? BigInt(pool.active_stake) : BigInt(pool.active_stake || 0);
    return acc + activeStake;
  }, BigInt(0));

  // Log totals for debugging/monitoring
  console.log(`Total live pledge: ${totalLivePledge.toString()}`);
  console.log(`Total pledge: ${totalPledge.toString()}`);
  console.log(`Total voting power: ${totalVotingPower.toString()}`);
  console.log(`Total active stake: ${totalActiveStake.toString()}`);

  // Return results as strings (BigInt values converted to strings for JSON compatibility)
  return {
    poolsData: poolData,
    totalLivePledge: totalLivePledge.toString(),
    totalVotingPower: totalVotingPower.toString(),
    totalActiveStake: totalActiveStake.toString()
  };
}