// Stakeholder validator — on-demand Cardano-account validation backed
// by the normalized Koios/Blockfrost layer (helper/cardanoApi.js).
//
// Reads optional per-ballot requirements from the stake entry of
// `Ballot.voterGroups[]`. Three independent checks, AND-combined:
//
//   1. mustExist (default true)
//      — stake address must be on chain. Accept if account_info
//        returns a row (registered or not — as long as it appears)
//        OR account_utxos comes back non-empty. That covers voters
//        who never registered their stake key but hold funds under
//        an address that references it.
//   2. allowedPools (optional string[])
//      — voter must be currently delegated to one of the listed
//        pool bech32 IDs. Absent = any delegation accepted.
//   3. tokenHoldings (optional array)
//      — voter must hold ≥ minQuantity of each listed entry.
//        `assetName` absent = any asset under the policy counts.
//
// Voting power: total_balance from account_info (lovelace, string).
//
// Cache: 8-hour UserCache TTL, matching the pattern used by the
// existing DRep + pool validators.
//
// Follow-up: migrate voterValidationDReps.js +
// voterValidationPoolsPledge.js onto helper/cardanoApi.js so all
// three groups share the same fallback-capable transport.

import {
  checkVoterValidation,
  saveVoterValidation,
  saveVotingPower,
} from '../helper/voterValidation.js';
import { Ballot } from '../schema/Ballot.js';
import { UserCache } from '../schema/UserCache.js';
import { accountInfo, accountAssets, accountUtxos, CardanoApiError } from '../helper/cardanoApi.js';

const VALIDATION_CACHE_HOURS = 8;

/**
 * Look up the per-ballot requirements object for the "stake" group.
 * Returns {} when no voterGroups entry exists or carries no
 * requirements — mustExist defaults apply downstream.
 */
function stakeRequirementsFor(ballot) {
  const groups = Array.isArray(ballot?.voterGroups) ? ballot.voterGroups : [];
  const stakeGroup = groups.find((g) => g?.group === 'stake');
  return stakeGroup?.requirements || {};
}

/**
 * True when the account passes the allowedPools check. `null` /
 * `undefined` / empty array in requirements means "any pool accepted."
 */
function poolOk(delegatedPool, allowedPools) {
  if (!Array.isArray(allowedPools) || allowedPools.length === 0) return true;
  if (!delegatedPool) return false;
  return allowedPools.includes(delegatedPool);
}

/**
 * AND across every tokenHoldings entry. Each entry requires:
 *   sum(quantity where policyId matches AND (assetName absent OR matches))
 *   ≥ BigInt(minQuantity)
 */
function tokensOk(assets, tokenHoldings) {
  if (!Array.isArray(tokenHoldings) || tokenHoldings.length === 0) return true;
  for (const req of tokenHoldings) {
    const threshold = BigInt(req.minQuantity ?? '0');
    let total = 0n;
    for (const a of assets) {
      if (a.policyId !== req.policyId) continue;
      if (req.assetName != null && a.assetName !== req.assetName) continue;
      total += BigInt(a.quantity || '0');
      if (total >= threshold) break;
    }
    if (total < threshold) return false;
  }
  return true;
}

async function existsOnChain(stakeAddr, info) {
  if (info) return true;
  // account_info returned null (unknown) — last-ditch UTxO check.
  // Covers the "address holds funds but stake key never registered"
  // case: Koios treats that stake credential as unknown to
  // /account_info but /account_utxos may still return rows.
  try {
    const utxos = await accountUtxos(stakeAddr);
    return Array.isArray(utxos) && utxos.length > 0;
  } catch (err) {
    console.log('[voterValidationStakeholder] utxo probe failed:', err.message);
    return false;
  }
}

export async function validateVoter(userId, ballotId) {
  const ballot = await Ballot.findOne({ _id: ballotId }).lean();
  if (!ballot) return false;

  const existing = await checkVoterValidation(userId, ballotId);
  if (
    existing?.updatedAt &&
    existing.updatedAt > Date.now() - 1000 * 60 * 60 * VALIDATION_CACHE_HOURS
  ) {
    return Boolean(existing.validated);
  }

  // Ballots only validate while live. `checkVoterValidation` readers
  // elsewhere expect this guard (mirrors the pattern in
  // voterValidationDReps).
  if (ballot.status !== 'live') {
    if (!existing) return false;
    return Boolean(existing.validated);
  }

  const req = stakeRequirementsFor(ballot);
  const mustExist = req.mustExist !== false; // default true

  try {
    const info = await accountInfo(userId);
    const exists = await existsOnChain(userId, info);

    if (mustExist && !exists) {
      console.log('[voterValidationStakeholder] not on chain:', userId);
      await saveVoterValidation(userId, ballotId, false, 'stake');
      await saveVotingPower(userId, ballotId, 0, 'stake');
      return false;
    }

    // Pool allow-list check. When info is null (exists-via-UTxO-only
    // path), delegatedPool is unknown — treat as not-delegated and
    // reject if an allow-list is configured.
    if (!poolOk(info?.delegatedPool || null, req.allowedPools)) {
      console.log(
        '[voterValidationStakeholder] pool not in allow-list:',
        userId,
        info?.delegatedPool,
      );
      await saveVoterValidation(userId, ballotId, false, 'stake');
      await saveVotingPower(userId, ballotId, 0, 'stake');
      return false;
    }

    // Token-holdings threshold check.
    if (Array.isArray(req.tokenHoldings) && req.tokenHoldings.length > 0) {
      const assets = await accountAssets(userId);
      if (!tokensOk(assets, req.tokenHoldings)) {
        console.log('[voterValidationStakeholder] token thresholds not met:', userId);
        await saveVoterValidation(userId, ballotId, false, 'stake');
        await saveVotingPower(userId, ballotId, 0, 'stake');
        return false;
      }
    }

    // Passed every configured check. Power = stake controlled by the
    // account (total_balance lovelace). Falls back to 0 when
    // account_info was null (UTxO-only existence) — the voter still
    // counts as eligible, just with no weight under StakeBased.
    const power = info?.totalBalance ? String(info.totalBalance) : '0';
    await saveVoterValidation(userId, ballotId, true, 'stake');
    await saveVotingPower(userId, ballotId, power, 'stake');
    return true;
  } catch (err) {
    if (err instanceof CardanoApiError) {
      console.error(
        `[voterValidationStakeholder] upstream failure: ${err.code} ${err.status || ''} — ${err.message}`,
      );
    } else {
      console.error('[voterValidationStakeholder] unexpected error:', err);
    }
    // Do not cache a false result on upstream failure — let the next
    // attempt re-hit the API. Propagate so the route can return 502
    // rather than silently denying the voter.
    throw err;
  }
}

/**
 * Allowed-voter count for /ballots dashboards. With lazy validation
 * the only voters we know about are those who've already passed
 * through /draft; count the validated UserCache rows.
 */
export async function allowedVoterCount(ballotId) {
  return UserCache.countDocuments({
    ballotId,
    validated: true,
    voterGroup: 'stake',
  });
}

export async function getTotalWeight(ballotId) {
  const agg = await UserCache.aggregate([
    { $match: { ballotId, validated: true, voterGroup: 'stake' } },
    { $group: { _id: null, total: { $sum: '$votingPower' } } },
  ]);
  return agg[0]?.total || 0;
}

export { computeFromUserCache as computePerVoterPower } from '../helper/votingPower/computeFromUserCache.js';
