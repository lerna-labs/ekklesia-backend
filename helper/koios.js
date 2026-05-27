/**
 * Helper functions for interacting with the Koios API and related services.
 * Provides utilities for DReps (names, validation, listing), stake pools (totals, Calidus keys),
 * Cardano handles (Handle.me and Koios fallback), and script information.
 *
 * @fileoverview Koios API and Handle.me integration
 * @module helper/koios
 */

/**
 * Lazily read Koios config. Importing this module no longer requires
 * API_URL / API_TOKEN — each exported function calls these getters, which
 * throw only when the function is actually invoked.
 */
function apiUrl() {
    const v = process.env.API_URL;
    if (!v) throw new Error("API URL is not set!");
    return v;
}
function apiToken() {
    const v = process.env.API_TOKEN;
    if (!v) throw new Error("API Token is not set!");
    return v;
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
 * !! OUTDATED - HAS BEEN REPLACED BY EKKLESIA HELPERS - MARKED FOR CLEANUP
 *
 * @description
 * This function queries the Koios API to get DRep information, then fetches the metadata
 * URL to retrieve the DRep's name. It attempts to return the name from the dRepName field's
 * @value property, falling back to givenName if dRepName is not available.
 *
 * @param {string} drepId - The DRep ID (e.g., "drep1y22hlaj8wuyygpnjy5cf96tg9tgvjrz39kxvqgv898uj9scfc55t7")
 *
 * @returns {Promise<string|undefined|null>} DRep name from dRepName["@value"], or givenName; undefined if no name in metadata; null if DRep not found or on error. Does not throw.
 *
 * @example
 * const name = await fetchDrepName("drep1y22hlaj8wuyygpnjy5cf96tg9tgvjrz39kxvqgv898uj9scfc55t7");
 * console.log(name); // "Maureen"
 */
export async function fetchDrepName(drepId) {
    try {
        const response = await fetch(`${apiUrl()}/drep_info?registered=eq.true`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiToken()}`,
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
 * Validates that a DRep ID is registered with the Koios API (drep_info, registered=eq.true).
 *
 * @param {string} drepId - DRep ID in CIP129 Bech32 format (e.g. "drep1...")
 * @returns {Promise<boolean>} True if registered and found, false otherwise or on error
 *
 * @example
 * const ok = await validateDrep("drep1...");
 * if (ok) { console.log("DRep is registered"); }
 */
export async function validateDrep(drepId) {
    try {
        const response = await fetch(`${apiUrl()}/drep_info?registered=eq.true`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiToken()}`,
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
        const response = await fetch(`${apiUrl()}/${endpoint}?policy_id=eq.${handlePolicyId}`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiToken()}`,
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
            const getHandleMetadataResponse = await fetch(`${apiUrl()}/asset_info`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiToken()}`,
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
 * Tries Handle.me first; on failure (e.g. network), falls back to Koios asset lookup.
 *
 * @param {string} address - Cardano address (stake or payment, e.g. "stake1...", "addr1...")
 * @returns {Promise<string|null>} Handle name if found, null otherwise
 *
 * @example
 * const handle = await fetchHandle("stake1...");
 * console.log(handle ?? "No handle");
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
 * Uses the script_info endpoint; does not throw on invalid hash or API errors.
 *
 * @param {string} scriptHash - Hexadecimal script hash to look up
 * @returns {Promise<Object|false>} Script data object if found, false on error or not found
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
        const scripts = await fetch(apiUrl() + "/script_info", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Prefer: "count=exact", // Request exact count in response headers
                authorization: `Bearer ${apiToken()}`,
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
 * Fetches the latest Calidus key for a stake pool from the Koios API (pool_calidus_keys).
 *
 * @param {string} poolBech32 - Pool ID in bech32 format (e.g. "pool1...")
 * @returns {Promise<CalidusKey|null>} Calidus key record if found, null otherwise or on error
 *
 * @example
 * const key = await fetchCalidusKey("pool1...");
 * if (key) { console.log(key.calidus_pub_key); }
 */
export async function fetchCalidusKey(poolBech32) {
    try {
        const response = await fetch(
            `${apiUrl()}/pool_calidus_keys?pool_id_bech32=eq.${poolBech32}`,
            {
                headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${apiToken()}`,
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

/**
 * @typedef {Object} PoolInfoRow
 * @property {string} pool_id_bech32 - Pool ID in bech32 format
 * @property {string|number} [pledge] - Declared pledge (lovelace)
 * @property {string|number} [live_pledge] - Current active pledge (lovelace)
 * @property {string|number} [voting_power] - Voting power (lovelace)
 * @property {string|number} [active_stake] - Active stake (lovelace)
 */

/**
 * @typedef {Object} FetchPoolTotalsResult
 * @property {PoolInfoRow[]} poolData - All registered pool records from pool_info
 * @property {string} totalLivePledge - Sum of live_pledge (lovelace as string)
 * @property {string} totalPledge - Sum of pledge (lovelace as string)
 * @property {string} totalVotingPower - Sum of voting_power (lovelace as string)
 * @property {string} totalActiveStake - Sum of active_stake (lovelace as string)
 */

/**
 * Fetches all registered pools from the Koios API and calculates aggregate totals.
 * Uses paginated pool_list then pool_info; totals are computed with BigInt and returned as strings.
 *
 * @returns {Promise<FetchPoolTotalsResult|{ error: string }>} Totals and pool array, or error object on failure
 *
 * @example
 * const result = await fetchPoolTotals();
 * if (result.error) {
 *   console.error(result.error);
 * } else {
 *   console.log("Pools:", result.poolData.length, "Total live pledge:", result.totalLivePledge);
 * }
 */
export async function fetchPoolTotals() {
    let poolData = [];
    console.log("Fetching pool totals...");

    let page = 1;
    const limit = 75;
    let offset = (page - 1) * limit;
    let totalCount = 0;

    try {
        const requestTotalCount = await fetch(
            `${apiUrl()}/pool_list?pool_status=eq.registered&select=pool_status,pool_id_bech32&limit=1`,
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${apiToken()}`,
                    prefer: "count=exact",
                },
            }
        );
        const rangeHeader = requestTotalCount.headers.get("content-range");
        totalCount = rangeHeader ? parseInt(rangeHeader.split("/")[1], 10) : 0;
        if (!totalCount || isNaN(totalCount)) {
            console.log("No pools or invalid count");
            return { poolData: [], totalLivePledge: "0", totalPledge: "0", totalVotingPower: "0", totalActiveStake: "0" };
        }
        console.log(`Total pools: ${totalCount}`);
    } catch (error) {
        console.error(`Error fetching total count of pools: ${error.message}`);
        return { error: `Error fetching total count of pools: ${error.message}` };
    }

    while (offset < totalCount) {
        try {
            console.log(`Fetching Pool page ${page}/${Math.ceil(totalCount / limit)}`);

            const requestPoolList = await fetch(
                `${apiUrl()}/pool_list?pool_status=eq.registered&select=pool_id_bech32,pool_status&offset=${offset}&limit=${limit}`,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        authorization: `Bearer ${apiToken()}`,
                        prefer: "count=exact",
                    },
                }
            );
            const pools = await requestPoolList.json();

            const requestPoolData = await fetch(
                `${apiUrl()}/pool_info?select=pool_id_bech32,pledge,live_pledge,voting_power,active_stake`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        authorization: `Bearer ${apiToken()}`,
                    },
                    body: JSON.stringify({
                        _pool_bech32_ids: pools.map((pool) => pool.pool_id_bech32),
                    }),
                }
            );

            const poolDataJSON = await requestPoolData.json();
            poolData.push(...poolDataJSON);

            page++;
            offset = (page - 1) * limit;
        } catch (error) {
            console.error(`Error fetching pool data: ${error.message}`);
            return { error: `Error fetching pool data: ${error.message}` };
        }
    }

    console.log(`Fetched ${poolData.length} pools`);

    const totalLivePledge = poolData.reduce((acc, pool) => {
        const livePledge = typeof pool.live_pledge === "string" ? BigInt(pool.live_pledge) : BigInt(pool.live_pledge || 0);
        return acc + livePledge;
    }, BigInt(0));

    const totalPledge = poolData.reduce((acc, pool) => {
        const pledge = typeof pool.pledge === "string" ? BigInt(pool.pledge) : BigInt(pool.pledge || 0);
        return acc + pledge;
    }, BigInt(0));

    const totalVotingPower = poolData.reduce((acc, pool) => {
        const votingPower = typeof pool.voting_power === "string" ? BigInt(pool.voting_power) : BigInt(pool.voting_power || 0);
        return acc + votingPower;
    }, BigInt(0));

    const totalActiveStake = poolData.reduce((acc, pool) => {
        const activeStake = typeof pool.active_stake === "string" ? BigInt(pool.active_stake) : BigInt(pool.active_stake || 0);
        return acc + activeStake;
    }, BigInt(0));

    console.log(`Total live pledge: ${totalLivePledge.toString()}`);
    console.log(`Total pledge: ${totalPledge.toString()}`);
    console.log(`Total voting power: ${totalVotingPower.toString()}`);
    console.log(`Total active stake: ${totalActiveStake.toString()}`);

    return {
        poolData,
        totalLivePledge: totalLivePledge.toString(),
        totalPledge: totalPledge.toString(),
        totalVotingPower: totalVotingPower.toString(),
        totalActiveStake: totalActiveStake.toString(),
    };
}

/**
 * Fetches all registered DReps from the Koios API with pagination.
 * Uses drep_list for IDs then drep_info for drep_id, registered, and amount per batch.
 *
 * @returns {Promise<Array<{ drep_id: string, registered: boolean, amount: string }>|{ error: string }>} Array of DRep info objects, or error object on failure
 *
 * @example
 * const dreps = await fetchAllDReps();
 * if (!Array.isArray(dreps)) {
 *   console.error(dreps.error);
 * } else {
 *   console.log("DReps:", dreps.length);
 * }
 */
export async function fetchAllDReps() {
    let page = 1;
    const limit = 50;
    let offset = (page - 1) * limit;
    let totalCount = 0;
    let dreps = [];
    console.log("Fetching all dreps...");

    try {
        const requestTotalCount = await fetch(
            `${apiUrl()}/drep_list?registered=eq.true&select=drep_id,registered&limit=1`,
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${apiToken()}`,
                    prefer: "count=exact",
                },
            }
        );
        const rangeHeader = requestTotalCount.headers.get("content-range");
        totalCount = rangeHeader ? parseInt(rangeHeader.split("/")[1], 10) : 0;
        if (!totalCount || isNaN(totalCount)) {
            console.log("No dreps or invalid count");
            return dreps;
        }
        console.log(`Total dreps: ${totalCount}`);
    } catch (error) {
        console.error(`Error fetching total count of dreps: ${error.message}`);
        return { error: `Error fetching total count of dreps: ${error.message}` };
    }

    while (offset < totalCount) {
        try {
            console.log(`Fetching DRep page ${page}/${Math.ceil(totalCount / limit)}`);
            const requestDreps = await fetch(
                `${apiUrl()}/drep_list?registered=eq.true&select=drep_id,registered&offset=${offset}&limit=${limit}`,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        authorization: `Bearer ${apiToken()}`,
                        prefer: "count=exact",
                    },
                }
            );
            const drepsJSON = await requestDreps.json();

            const requestDrepInfo = await fetch(
                `${apiUrl()}/drep_info?select=drep_id,registered,amount`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        authorization: `Bearer ${apiToken()}`,
                    },
                    body: JSON.stringify({
                        _drep_ids: drepsJSON.map((drep) => drep.drep_id),
                    }),
                }
            );
            const drepInfoJSON = await requestDrepInfo.json();
            dreps.push(...drepInfoJSON);

            page++;
            offset = (page - 1) * limit;
        } catch (error) {
            console.error(`Error fetching dreps: ${error.message}`);
            return { error: `Error fetching dreps: ${error.message}` };
        }
    }

    console.log(`Fetched ${dreps.length} dreps`);
    return dreps;
}