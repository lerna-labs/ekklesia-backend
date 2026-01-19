// creates the voter cache for all eligable pools and checks if live_pledge is equal or greater than pledge
import { getPoolTotals } from "../helper/koios.js";
import { VoterCache } from "../schema/VoterCache.js";
export async function startupBallot(ballotId) {
    console.log("Startup Script for Ballot", ballotId);
    const poolTotals = await getPoolTotals();
    if (poolTotals.error) {
        console.error(poolTotals.error);
        process.exit(1);
    }

    // loop through pools and remove from poolData where live_pledge isn't larger or equal to pledge
    for (const pool of poolTotals.poolData) {
        if (pool.live_pledge < pool.pledge) {
            console.log("Pool live pledge is smaller than pledge: ", pool.live_pledge, pool.pledge);
            poolTotals.poolsData = poolTotals.poolsData.filter(p => p.pool_id_bech32 !== pool.pool_id_bech32);
        }
    }

    // upsert voter cache for all pools in poolTotals.poolsData and set voting_power to pledge
    for (const pool of poolTotals.poolData) {
        await VoterCache.findOneAndUpdate({ ballotId: ballotId, voterId: pool.pool_id_bech32 }, { votingPower: pool.pledge }, { upsert: true });
    }

    console.log("Voter cache created for", poolTotals.poolsData.length, "pools");
    return true;
}