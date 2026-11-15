/**
 * Helper functions for interacting with the Koios API and related services.
 * Provides utilities for listing DReps and totalling stake pools.
 *
 * @fileoverview Koios API integration
 * @module helper/koios
 */

/**
 * Lazily read Koios config. Importing this module no longer requires
 * API_URL / API_TOKEN — each exported function calls these getters, which
 * throw only when the function is actually invoked.
 */
function apiUrl() {
  const v = process.env.API_URL;
  if (!v) throw new Error('API URL is not set!');
  return v;
}
function apiToken() {
  const v = process.env.API_TOKEN;
  if (!v) throw new Error('API Token is not set!');
  return v;
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
  console.log('Fetching pool totals...');

  let page = 1;
  const limit = 75;
  let offset = (page - 1) * limit;
  let totalCount = 0;

  try {
    const requestTotalCount = await fetch(
      `${apiUrl()}/pool_list?pool_status=eq.registered&select=pool_status,pool_id_bech32&limit=1`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${apiToken()}`,
          prefer: 'count=exact',
        },
      },
    );
    const rangeHeader = requestTotalCount.headers.get('content-range');
    totalCount = rangeHeader ? parseInt(rangeHeader.split('/')[1], 10) : 0;
    if (!totalCount || isNaN(totalCount)) {
      console.log('No pools or invalid count');
      return {
        poolData: [],
        totalLivePledge: '0',
        totalPledge: '0',
        totalVotingPower: '0',
        totalActiveStake: '0',
      };
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
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${apiToken()}`,
            prefer: 'count=exact',
          },
        },
      );
      const pools = await requestPoolList.json();

      const requestPoolData = await fetch(
        `${apiUrl()}/pool_info?select=pool_id_bech32,pledge,live_pledge,voting_power,active_stake`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${apiToken()}`,
          },
          body: JSON.stringify({
            _pool_bech32_ids: pools.map((pool) => pool.pool_id_bech32),
          }),
        },
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
    const livePledge =
      typeof pool.live_pledge === 'string'
        ? BigInt(pool.live_pledge)
        : BigInt(pool.live_pledge || 0);
    return acc + livePledge;
  }, BigInt(0));

  const totalPledge = poolData.reduce((acc, pool) => {
    const pledge = typeof pool.pledge === 'string' ? BigInt(pool.pledge) : BigInt(pool.pledge || 0);
    return acc + pledge;
  }, BigInt(0));

  const totalVotingPower = poolData.reduce((acc, pool) => {
    const votingPower =
      typeof pool.voting_power === 'string'
        ? BigInt(pool.voting_power)
        : BigInt(pool.voting_power || 0);
    return acc + votingPower;
  }, BigInt(0));

  const totalActiveStake = poolData.reduce((acc, pool) => {
    const activeStake =
      typeof pool.active_stake === 'string'
        ? BigInt(pool.active_stake)
        : BigInt(pool.active_stake || 0);
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
  console.log('Fetching all dreps...');

  try {
    const requestTotalCount = await fetch(
      `${apiUrl()}/drep_list?registered=eq.true&select=drep_id,registered&limit=1`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${apiToken()}`,
          prefer: 'count=exact',
        },
      },
    );
    const rangeHeader = requestTotalCount.headers.get('content-range');
    totalCount = rangeHeader ? parseInt(rangeHeader.split('/')[1], 10) : 0;
    if (!totalCount || isNaN(totalCount)) {
      console.log('No dreps or invalid count');
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
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${apiToken()}`,
            prefer: 'count=exact',
          },
        },
      );
      const drepsJSON = await requestDreps.json();

      const requestDrepInfo = await fetch(
        `${apiUrl()}/drep_info?select=drep_id,registered,amount`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${apiToken()}`,
          },
          body: JSON.stringify({
            _drep_ids: drepsJSON.map((drep) => drep.drep_id),
          }),
        },
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
