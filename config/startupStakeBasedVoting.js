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

    // upsert voter cache for all pools in poolTotals.poolsData and set voting_power to pledge
    for (const pool of poolTotals.poolData) {
        await VoterCache.findOneAndUpdate({ ballotId: ballotId, userId: pool.pool_id_bech32 }, { votingPower: pool.active_stake, validated: true }, { upsert: true });
    }

    console.log("Voter cache created for", poolTotals.poolData.length, "pools");
    return true;
}