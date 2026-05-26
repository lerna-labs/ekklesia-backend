// Backfill UserCache rows for every distinct voter on a ballot who appears
// in the Vote collection, by re-running the ballot's voterValidationScript
// (same logic as POST /api/v1/votes/draft eligibility).
//
// Prerequisites:
//   - ballot.voterValidationScript must match the ballot type (e.g.
//     voterValidationDReps.js for DRep ballots). voterValidationAlwaysTrue.js
//     writes voterGroup "default", which violates the UserCache enum.
//   - Env vars required by that script must be set (e.g. API_URL,
//     API_TOKEN for DRep/pool validators).
//   - Ballot should be "live" so validators call upstream APIs and persist cache.
//
// --force deletes the existing UserCache row before each validateVoter call
// (bypasses 8-hour validator cache and alwaysTrue early-return). Full row
// delete includes nonce; voters mid-flight may need to re-draft.
//
// Usage:
//   NODE_ENV=production node __scripts/revalidateBallotVoters.js --ballot <id> --force
//   NODE_ENV=production node __scripts/revalidateBallotVoters.js --ballot <id> --force --recompute
//   NODE_ENV=production node __scripts/revalidateBallotVoters.js --ballot <id> --dry-run
//   node __scripts/revalidateBallotVoters.js --ballot <id> --submitted-only --force
//
// Exit codes:
//   0 — all voters processed, no errors
//   1 — missing --ballot, ballot not found, or script lacks validateVoter
//   2 — one or more per-voter validation failures

import process from "process";
import mongoose from "mongoose";
import { bootstrap, teardown, parseArgs } from "./scaffold/common/env.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Vote } from "../schema/Vote.js";
import { UserCache } from "../schema/UserCache.js";
import { loadValidationScript } from "../helper/loadValidationScript.js";
import { tallyProposalProvisional } from "../crons/10minAggregateVotes.js";

const { flags } = parseArgs();
const dryRun = Boolean(flags["dry-run"]);
const force = Boolean(flags.force);
const submittedOnly = Boolean(flags["submitted-only"]);
const recompute = Boolean(flags.recompute);
const ballotIdArg = flags.ballot || null;

function validationSucceeded(result) {
  return result === true || result?.validated === true;
}

if (!ballotIdArg) {
  console.error("[revalidate] --ballot <id> is required");
  process.exit(1);
}

if (!mongoose.isValidObjectId(ballotIdArg)) {
  console.error(`[revalidate] invalid ballot id: ${ballotIdArg}`);
  process.exit(1);
}

await bootstrap();

const ballot = await Ballot.findById(ballotIdArg)
  .select("_id title status source voterValidationScript provisionalResultsEnabled")
  .lean();

if (!ballot) {
  console.error(`[revalidate] no ballot found for id ${ballotIdArg}`);
  await teardown();
  process.exit(1);
}

const voteFilter = { ballotId: ballot._id };
if (submittedOnly) {
  voteFilter.submittedAt = { $ne: null };
}

const userIds = await Vote.distinct("userId", voteFilter);
userIds.sort();

console.log(
  `[revalidate] ballot ${ballot._id} "${ballot.title}" (${ballot.source}/${ballot.status})`
);
console.log(
  `[revalidate] script: ${ballot.voterValidationScript || "(unset)"} | voters: ${userIds.length}${submittedOnly ? " (submitted only)" : ""}${force ? " | --force" : ""}${dryRun ? " | DRY RUN" : ""}`
);

if (userIds.length === 0) {
  console.log("[revalidate] no voters found in Vote collection — nothing to do");
  await teardown();
  process.exit(0);
}

let mod;
if (!dryRun) {
  if (!ballot.voterValidationScript) {
    console.error("[revalidate] ballot has no voterValidationScript");
    await teardown();
    process.exit(1);
  }
  try {
    mod = await loadValidationScript(ballot.voterValidationScript);
  } catch (err) {
    console.error(`[revalidate] failed to load script: ${err.message}`);
    await teardown();
    process.exit(1);
  }
  if (typeof mod?.validateVoter !== "function") {
    console.error(
      `[revalidate] ${ballot.voterValidationScript} does not export validateVoter`
    );
    await teardown();
    process.exit(1);
  }
}

if (dryRun) {
  console.log("[revalidate] voter userIds:");
  for (const userId of userIds) {
    console.log(`  ${userId}`);
  }
  if (recompute) {
    const proposalCount = await Proposal.countDocuments({ ballotId: ballot._id });
    console.log(
      `[revalidate] would recompute ${proposalCount} proposal(s) after validation`
    );
  }
  await teardown();
  process.exit(0);
}

const tallies = { validated: 0, denied: 0, errors: 0, cacheDeleted: 0 };

for (const userId of userIds) {
  try {
    if (force) {
      const del = await UserCache.deleteOne({ ballotId: ballot._id, userId });
      if (del.deletedCount > 0) tallies.cacheDeleted++;
    }

    const result = await mod.validateVoter(userId, ballot._id);
    if (validationSucceeded(result)) {
      tallies.validated++;
      const row = await UserCache.findOne({ ballotId: ballot._id, userId })
        .select("voterGroup votingPower validated")
        .lean();
      console.log(
        `[revalidate] ok ${userId} group=${row?.voterGroup ?? "?"} power=${row?.votingPower ?? "?"}`
      );
    } else {
      tallies.denied++;
      console.log(`[revalidate] denied ${userId}`);
    }
  } catch (err) {
    tallies.errors++;
    console.error(`[revalidate] error ${userId}: ${err.message}`);
  }
}

console.log(
  `\n[revalidate] validation done. validated=${tallies.validated} denied=${tallies.denied} errors=${tallies.errors} cacheDeleted=${tallies.cacheDeleted}`
);

if (recompute) {
  const proposals = await Proposal.find({ ballotId: ballot._id })
    .select("_id")
    .sort({ position: 1, _id: 1 })
    .lean();
  console.log(`[revalidate] recomputing ${proposals.length} proposal(s)...`);
  const ballotCache = new Map();
  const recomputeTallies = { updated: 0, skipped: 0, errors: 0 };
  for (const p of proposals) {
    try {
      const outcome = await tallyProposalProvisional(p._id, { ballotCache });
      recomputeTallies[outcome] = (recomputeTallies[outcome] || 0) + 1;
    } catch (err) {
      recomputeTallies.errors++;
      console.error(`[revalidate] recompute proposal ${p._id} failed: ${err.message}`);
    }
  }
  console.log(
    `[revalidate] recompute done. updated=${recomputeTallies.updated} skipped=${recomputeTallies.skipped} errors=${recomputeTallies.errors}`
  );
  if (recomputeTallies.errors > 0) {
    tallies.errors += recomputeTallies.errors;
  }
}

await teardown();
process.exit(tallies.errors > 0 ? 2 : 0);
