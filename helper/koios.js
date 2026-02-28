/**
 * @fileoverview Helper functions for interacting with the Koios API.
 * Provides utilities for fetching DRep names and Cardano handles.
 *
 * @module helper/koios
 */

const API_URL = process.env.API_URL;
const API_TOKEN = process.env.API_TOKEN;

if (!API_URL) {
    console.error("API_URL is not set in the environment variables.");
    throw new Error("API URL is not set!");
}

if (!API_TOKEN) {
    console.error("API_TOKEN is not set in the environment variables.");
    throw new Error("API Token is not set!");
}

/**
 * @typedef {Object} DrepInfo
 * @property {string} drep_id - DRep ID in bech32 format
 * @property {string} hex - DRep ID in hex format
 * @property {boolean} has_script - Whether the DRep is script-based
 * @property {boolean} registered - Whether the DRep is currently registered
 * @property {string} deposit - DRep deposit amount (lovelace as string)
 * @property {boolean} active - Whether the DRep is currently active
 * @property {number} expires_epoch_no - Epoch number when the DRep registration expires
 * @property {string} amount - Delegated voting power (lovelace as string)
 * @property {string|null} meta_url - URL to the DRep's CIP-119 metadata JSON
 * @property {string|null} meta_hash - Hash of the metadata file
 */

/**
 * @typedef {Object} DrepMetadata
 * @property {Object} body - Metadata body
 * @property {Object} [body.dRepName] - DRep name object
 * @property {string} [body.dRepName.@value] - DRep display name
 * @property {string} [body.givenName] - Fallback given name
 */

/**
 * Fetches the DRep name for a given DRep ID from the Koios API.
 *
 * @description
 * This function queries the Koios API to get DRep information, then fetches the metadata
 * URL to retrieve the DRep's name. It attempts to return the name from the dRepName field's
 * @value property, falling back to givenName if dRepName is not available.
 *
 * @param {string} drepId - The DRep ID (e.g., "drep1y22hlaj8wuyygpnjy5cf96tg9tgvjrz39kxvqgv898uj9scfc55t7")
 *
 * @returns {Promise<string|undefined|null>} Returns:
 *   - The DRep name string from dRepName["@value"] if available
 *   - The givenName string as fallback if dRepName is not available
 *   - undefined if neither name field is found in metadata
 *   - null if no DRep is found or if an error occurs during the initial API call
 *
 * @throws {Error} Logs errors to console but does not throw - returns null or undefined on error
 *
 * @example
 * const name = await fetchDrepName("drep1y22hlaj8wuyygpnjy5cf96tg9tgvjrz39kxvqgv898uj9scfc55t7");
 * console.log(name); // "Maureen"
 */
export async function fetchDrepName(drepId) {
    try {
        const response = await fetch(`${API_URL}/drep_info?registered=eq.true`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    "_drep_ids": [drepId],
                }),
            }
        );
        const /** @type {DrepInfo[]} */ data = await response.json();

        if (data.length === 0) {
            console.log("No DRep found");
            return null;
        }

        // check if drep meta url is present
        if (!data[0].meta_url) {
            console.log("No DRep metadata URL found");
            return undefined;
        }

        // fetch drep metadata
        try {
            console.log("Fetching DRep metadata:", data[0].meta_url);
            const drepMetadataResponse = await fetch(data[0].meta_url,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                    },
                }
            );
            const /** @type {DrepMetadata} */ drepMetadata = await drepMetadataResponse.json();

            // Return the @value property from dRepName if it exists
            if (drepMetadata.body?.dRepName?.["@value"]) {
                return drepMetadata.body.dRepName["@value"];
            }
            // Fallback to givenName if dRepName doesn't have @value
            else if (drepMetadata.body?.givenName) {
                return drepMetadata.body.givenName;
            }
            // Return undefined if neither is available
            else {
                console.log("No DRep name found");
                return undefined;
            }
        } catch (error) {
            console.error("Error fetching DRep metadata:", error);
            return undefined;
        }

    } catch (error) {
        console.error("Error fetching DRep name:", error);
        return null;
    }
}

/**
 * Validates that a DRep ID is registered with the Koios API.
 *
 * @param {string} drepId - The DRep ID (e.g. CIP129 Bech32 "drep1...")
 * @returns {Promise<boolean>} True if the DRep is registered (drep_info returns at least one result), false otherwise or on error.
 */
export async function validateDrep(drepId) {
    try {
        const response = await fetch(`${API_URL}/drep_info?registered=eq.true`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    "_drep_ids": [drepId],
                }),
            }
        );
        const data = await response.json();
        if (data.length === 0) {
            console.log("No DRep found");
            return false;
        }
        return true;
    } catch (error) {
        console.error("Error validating DRep:", error);
        return false;
    }
}

/**
 * @typedef {Object} HandleHolder
 * @property {number} total_handles
 * @property {string} address
 * @property {"wallet"|"script"|"enterprise"|"other"} type
 * @property {string} known_owner_name
 * @property {string} default_handle
 * @property {boolean} manually_set
 * @property {string[]} [handles]
 */

/**
 * Fetches the Cardano handle for a given address from the Handle.me API.
 * Throws on network errors or unexpected status codes so the caller can fall back.
 *
 * @param {string} address - The Cardano address (stake, payment, enterprise, or script address)
 * @returns {Promise<string|null>} The default handle name if found, null if address has no handle
 * @throws {Error} If the API is unreachable or returns an unexpected status
 */
async function fetchHandleMe(address) {
    const baseUrl = process.env.NETWORK_NAME === "mainnet"
        ? "https://api.handle.me"
        : "https://preprod.api.handle.me";
    const response = await fetch(`${baseUrl}/holders/${address}`);
    if (response.status === 200 || response.status === 202) {
        const /** @type {HandleHolder} */ data = await response.json();
        return data.default_handle || null;
    }
    if (response.status === 404) {
        return null;
    }
    throw new Error(`Handle.me returned unexpected status ${response.status}`);
}

/**
 * Fetches the Cardano handle (asset name) for a given address from the Koios API.
 *
 * @deprecated Use fetchHandleMe instead. Retained as fallback in case the Handle.me
 * preprod API is no longer operational.
 * @param {string} address - The Cardano address (stake address or payment address)
 * @returns {Promise<string|null>} The handle name if found, null otherwise
 */
async function fetchHandleKoios(address) {
    const handlePolicyId = "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a"
    let endpoint;
    let body;
    if (address.startsWith("stake")) {
        endpoint = 'account_assets';
        body = {
            "_stake_addresses": [address],
        };
    }
    if (address.startsWith("addr")) {
        endpoint = 'address_assets';
        body = {
            "_addresses": [address],
        };
    }
    if (!endpoint) {
        console.error("Invalid address");
        return null;
    }
    try {
        const response = await fetch(`${API_URL}/${endpoint}?policy_id=eq.${handlePolicyId}`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            }
        );
        const data = await response.json();
        if (data.length === 0) {
            console.log("No handle found");
            return null;
        }
        try {
            const getHandleMetadataResponse = await fetch(`${API_URL}/asset_info`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${API_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        "_asset_list": [[data[0].policy_id, data[0].asset_name]],
                    }),
                }
            );
            const getHandleMetadata = await getHandleMetadataResponse.json();
            return getHandleMetadata[0].asset_name_ascii;
        } catch (error) {
            console.error("Error fetching handle metadata:", error);
            return null;
        }

    } catch (error) {
        console.error("Error fetching endpoint:", error);
        return null;
    }
}

/**
 * Fetches the Cardano handle for a given address.
 * Tries Handle.me API first, falls back to Koios if Handle.me is unavailable.
 *
 * @param {string} address - The Cardano address (stake address or payment address)
 * @returns {Promise<string|null>} The handle name if found, null otherwise
 */
export async function fetchHandle(address) {
    try {
        return await fetchHandleMe(address);
    } catch (error) {
        console.error("Handle.me unavailable, falling back to Koios:", error.message);
        return fetchHandleKoios(address);
    }
}

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
    try {
        // Make an authenticated POST request to Koios script_info endpoint
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
 * @typedef {Object} CalidusKey
 * @property {string} pool_id_bech32 - Pool ID in bech32 format
 * @property {string} pool_status - Pool registration status ("registered", "retired", "unregistered")
 * @property {number} calidus_nonce - Calidus certificate nonce
 * @property {string} calidus_pub_key - Calidus public key (hex)
 * @property {string} calidus_id_bech32 - Calidus ID in bech32 format
 * @property {string} tx_hash - Transaction hash of the certificate (hex)
 * @property {number} epoch_no - Epoch number of the certificate
 * @property {number} block_height - Block height of the certificate
 * @property {number} block_time - Block time as Unix timestamp
 */

/**
 * Fetches the latest Calidus key for a given stake pool from the Koios API.
 *
 * @param {string} poolBech32 - The pool ID in bech32 format (e.g., "pool1...")
 * @returns {Promise<CalidusKey|null>} The Calidus key record if found, null otherwise or on error
 */
export async function fetchCalidusKey(poolBech32) {
    try {
        const response = await fetch(
            `${API_URL}/pool_calidus_keys?pool_id_bech32=eq.${poolBech32}`,
            {
                headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${API_TOKEN}`,
                },
            }
        );
        const data = await response.json();
        if (data.length === 0) {
            return null;
        }
        return data[0];
    } catch (error) {
        console.error("Error fetching Calidus key:", error);
        return null;
    }
}