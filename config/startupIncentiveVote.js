import { UserCache } from "../schema/UserCache.js";
import { getPoolTotals, getAllDreps } from "../helper/koios.js";

export async function startupBallot(ballotId) {
    console.log("Startup Script for Ballot", ballotId);

    const poolTotals = await getPoolTotals();
    if (poolTotals.error) {
        console.error(poolTotals.error);
        process.exit(1);
    }

    // loop through pools and remove from poolData where live_pledge isn't larger or equal to pledge
    for (const pool of poolTotals.poolData) {
        // Convert to BigInt for proper numeric comparison, treating null as 0
        const livePledge = pool.live_pledge === null || pool.live_pledge === undefined
            ? BigInt(0)
            : (typeof pool.live_pledge === 'string' ? BigInt(pool.live_pledge) : BigInt(pool.live_pledge || 0));
        const pledge = pool.pledge === null || pool.pledge === undefined
            ? BigInt(0)
            : (typeof pool.pledge === 'string' ? BigInt(pool.pledge) : BigInt(pool.pledge || 0));

        if (livePledge < pledge) {
            console.log("Pool live pledge is smaller than pledge: ", pool.live_pledge, pool.pledge);
            poolTotals.poolData = poolTotals.poolData.filter(p => p.pool_id_bech32 !== pool.pool_id_bech32);
        }
    }

    // upsert voter cache for all pools in poolTotals.poolsData and set voting_power to pledge
    for (const pool of poolTotals.poolData) {
        await UserCache.findOneAndUpdate(
            { ballotId: ballotId, userId: pool.pool_id_bech32 },
            { votingPower: pool.live_pledge, validated: true, voterGroup: "pool" },
            { upsert: true }
        );
    }

    console.log("Voter cache created for", poolTotals.poolData.length, "pools");


    const dreps = await getAllDreps();
    if (dreps.error) {
        console.error(dreps.error);
        process.exit(1);
    }

    // upsert voter cache for all dreps and set voting_power to amount
    for (const drep of dreps) {
        await UserCache.findOneAndUpdate(
            { ballotId: ballotId, userId: drep.drep_id },
            { votingPower: drep.amount, validated: true, voterGroup: "drep" },
            { upsert: true }
        );
    }
    return true;
}