// Credential-dispatching voter validator.
//
// Multi-group ballots (e.g. RSS v2 with drep + pool eligibility) need a
// validator that routes each incoming voter to the right per-group
// Koios-backed lookup based on the bech32 prefix of their userId. This
// script keeps the single-group validators as the source of truth —
// it's purely a thin dispatcher.
//
// Dispatch table:
//   drep1…     → voterValidationDReps.js         (Koios /drep_info)
//   pool1…     → voterValidationPoolsPledge.js   (Koios /pool_info, pledge)
//   calidus1…  → voterValidationPoolsPledge.js   (CIP-151 hot key for SPO)
//   stake1…    → voterValidationStakeholder.js   (Koios /account_info +
//                                                 /account_assets via
//                                                 helper/cardanoApi.js —
//                                                 Koios-primary,
//                                                 Blockfrost-fallback)
//
// **Voter-group gate.** Even when the bech32 HRP is recognized, the
// dispatcher rejects the voter unless the corresponding voter group
// (`drep` / `pool` / `stake`) appears in `ballot.voterGroups`. This is
// what stops a stake address from sliding into a `voterGroups:
// [drep, pool]` ballot — the misconfiguration that admitted a
// non-DRep voter to the budget ballot. Empty `voterGroups` is
// treated as "no restriction" so legacy ballots that pre-date the
// per-group declaration keep working.
//
// Returning `false` (unsupported HRP or HRP not in voterGroups) means
// the voter never gets a validated UserCache row — /draft then 403s
// with ELIGIBILITY_DENIED, which is the correct behavior.

import { Ballot } from "../schema/Ballot.js";
import {
  validateVoter as validateDRep,
  allowedVoterCount as dRepCount,
  getTotalWeight as dRepWeight,
} from "./voterValidationDReps.js";
import {
  validateVoter as validatePoolPledge,
  allowedVoterCount as poolCount,
  getTotalWeight as poolWeight,
} from "./voterValidationPoolsPledge.js";
import {
  validateVoter as validateStake,
  allowedVoterCount as stakeCount,
  getTotalWeight as stakeWeight,
} from "./voterValidationStakeholder.js";

function hrpOf(userId) {
  if (!userId || typeof userId !== "string") return null;
  const lower = userId.toLowerCase();
  if (lower.startsWith("drep")) return "drep";
  if (lower.startsWith("pool")) return "pool";
  if (lower.startsWith("calidus")) return "calidus";
  if (lower.startsWith("stake_test") || lower.startsWith("stake")) return "stake";
  return null;
}

// Map a bech32 HRP to the voterGroups bucket it belongs to. calidus is
// the CIP-151 hot key for an SPO so it lives in the `pool` bucket;
// stake_test is preprod stake. Matches the convention in
// helper/hydraEvidence.js:voterGroupFromHrp.
function voterGroupFor(hrp) {
  if (hrp === "drep") return "drep";
  if (hrp === "pool" || hrp === "calidus") return "pool";
  if (hrp === "stake") return "stake";
  return null;
}

export async function validateVoter(userId, ballotId) {
  const hrp = hrpOf(userId);
  if (!hrp) {
    console.log(
      "[voterValidationByCredential] unsupported voter HRP; rejecting",
      userId
    );
    return false;
  }

  // Voter-group gate: the ballot must declare the voter's class. Empty
  // `voterGroups` is permissive (legacy ballots). We read voterGroups
  // off the Ballot row directly so the gate stays in sync with whatever
  // the operator most recently saved — no extra config knob.
  const ballot = await Ballot.findById(ballotId).select("voterGroups").lean();
  if (!ballot) {
    console.log(
      "[voterValidationByCredential] ballot not found; rejecting",
      ballotId
    );
    return false;
  }
  const declaredGroups = Array.isArray(ballot.voterGroups)
    ? ballot.voterGroups.map((g) => g?.group).filter(Boolean)
    : [];
  const voterGroup = voterGroupFor(hrp);
  if (declaredGroups.length > 0 && voterGroup && !declaredGroups.includes(voterGroup)) {
    console.log(
      `[voterValidationByCredential] voter HRP "${hrp}" (group "${voterGroup}") ` +
        `not in ballot.voterGroups [${declaredGroups.join(", ")}]; rejecting`,
      userId
    );
    return false;
  }

  switch (hrp) {
    case "drep":
      return validateDRep(userId, ballotId);
    case "pool":
    case "calidus":
      return validatePoolPledge(userId, ballotId);
    case "stake":
      return validateStake(userId, ballotId);
    default:
      console.log(
        "[voterValidationByCredential] unsupported voter HRP; rejecting",
        userId
      );
      return false;
  }
}

/**
 * Sum of the per-group allowed-voter counts. Used by /ballot endpoints
 * that surface "total eligible voters" alongside the tally.
 */
export async function allowedVoterCount(ballotId) {
  const [drep, pool, stake] = await Promise.all([
    dRepCount(ballotId),
    poolCount(ballotId),
    stakeCount(ballotId),
  ]);
  return Number(drep || 0) + Number(pool || 0) + Number(stake || 0);
}

export async function getTotalWeight(ballotId) {
  const [drep, pool, stake] = await Promise.all([
    dRepWeight(ballotId),
    poolWeight(ballotId),
    stakeWeight(ballotId),
  ]);
  return Number(drep || 0) + Number(pool || 0) + Number(stake || 0);
}

// Per-voter power reader for snapshot/cron paths — falls back to
// UserCache (the row will have been written by whichever per-group
// validator ran for that voter at draft time).
export { computeFromUserCache as computePerVoterPower } from "../helper/votingPower/computeFromUserCache.js";
