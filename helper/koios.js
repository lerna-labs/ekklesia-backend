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