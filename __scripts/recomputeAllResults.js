// One-off retabulation of provisional Result docs across the full Vote
// history. Built for the case where the 10-min cron was not enabled (or
// crashed) while votes were already arriving — those proposals fall
// outside the cron's 12-min lookback and are never picked up on later
// passes.
//
// Reuses `tallyProposalProvisional` from crons/10minAggregateVotes.js so
// the math is byte-identical to what the cron writes; the only
// difference is that we walk every proposal instead of the recent-votes
// shortlist.
//
// Safety:
//   - Read-only against Vote/UserCache/Proposal/Ballot.
//   - Writes only to Result.
//   - Never touches Vote.submittedAt (unlike refreshScaffoldResults.js).
//   - Skips proposals whose Result.source is "final" or "certified" —
//     those are authoritative (Hydra-finalized or authority-snapshot
//     re-derived) and must not be clobbered by a provisional pass.
//     Use POST /api/v1/admin/ballots/:id/results/recover for the final
//     re-derivation path.
//   - Skips Hydra ballots with provisionalResultsEnabled === false,
//     since their local Vote rows are not the source of truth.
//
// Usage:
//   node __scripts/recomputeAllResults.js                       (every ballot)
//   node __scripts/recomputeAllResults.js --ballot <id>         (one ballot)
//   node __scripts/recomputeAllResults.js --dry-run             (no writes)
//   node __scripts/recomputeAllResults.js --ballot <id> --dry-run

import process from "process";
import { bootstrap, teardown, parseArgs } from "./scaffold/common/env.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { tallyProposalProvisional } from "../crons/10minAggregateVotes.js";

const { flags } = parseArgs();
const dryRun = Boolean(flags["dry-run"]);
const ballotFilterId = flags.ballot || null;

await bootstrap();

const ballotQuery = ballotFilterId ? { _id: ballotFilterId } : {};
const ballots = await Ballot.find(ballotQuery)
  .select("_id title status source provisionalResultsEnabled")
  .sort({ votePeriodStart: 1 })
  .lean();

if (ballots.length === 0) {
  console.error(
    ballotFilterId
      ? `[recompute] no ballot found for id ${ballotFilterId}`
      : "[recompute] no ballots in the database"
  );
  await teardown();
  process.exit(1);
}

console.log(
  `[recompute] ${dryRun ? "DRY RUN — " : ""}walking ${ballots.length} ballot(s)`
);

const ballotCache = new Map();
const tallies = { updated: 0, skipped: 0, errors: 0 };

for (const ballot of ballots) {
  const proposals = await Proposal.find({ ballotId: ballot._id })
    .select("_id")
    .sort({ position: 1, _id: 1 })
    .lean();
  console.log(
    `\n[recompute] ballot ${ballot._id} "${ballot.title}" (${ballot.source}/${ballot.status}) — ${proposals.length} proposal(s)`
  );
  for (const p of proposals) {
    try {
      const outcome = await tallyProposalProvisional(p._id, {
        ballotCache,
        dryRun,
      });
      tallies[outcome] = (tallies[outcome] || 0) + 1;
    } catch (err) {
      tallies.errors++;
      console.error(`[recompute] proposal ${p._id} failed: ${err.message}`);
    }
  }
}

console.log(
  `\n[recompute] done. updated=${tallies.updated} skipped=${tallies.skipped} errors=${tallies.errors}${dryRun ? " (DRY RUN — nothing written)" : ""}`
);

await teardown();
process.exit(tallies.errors > 0 ? 2 : 0);
