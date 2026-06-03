// Flag Vote rows as operator-excluded so results derivation, the voter
// directory, and voter-self-view all drop them. Used to clean up after
// an operator mistake (e.g. a misconfigured voterValidationScript that
// admitted ineligible voters).
//
// Sets these fields on each matching Vote row:
//   excludedAt:     Date (now)
//   excludedReason: --reason
//   excludedBy:     --by  (defaults to $USER)
//
// The Hydra audit record is NOT mutated. Hydra-final tallies and
// authority-certification re-derive from Hydra evidence / the
// authority's snapshot respectively, so the same voter is dropped
// there via the certification flow, not by this script.
//
// Selectors (combinable):
//   --ballotId <id>   restrict to one ballot
//   --userId <id>     restrict to one voter (bech32 drep / pool / stake / handle)
//   --proposalId <id> restrict to a single proposal (rare; usually you
//                     want to flag every proposal under a ballot at once)
//
// Required:
//   --reason <code>   short audit code, e.g. INELIGIBLE_VALIDATION_MISMATCH
//
// Optional:
//   --note <text>     free-text operator note (joined into excludedReason)
//   --by <user>       defaults to $USER
//   --undo            clear the exclusion fields on matching rows instead
//                     of setting them (resets excludedAt → null)
//
// Dry-run by default; pass --apply to write.
//
// Examples:
//   # Preview what would be excluded
//   node __scripts/excludeVote.js \
//     --ballotId 660b... --userId stake1u... \
//     --reason INELIGIBLE_VALIDATION_MISMATCH
//
//   # Apply
//   node __scripts/excludeVote.js \
//     --ballotId 660b... --userId stake1u... \
//     --reason INELIGIBLE_VALIDATION_MISMATCH \
//     --note "ballot was misconfigured with voterValidationByCredential" \
//     --apply
//
//   # Revert (e.g. flagged the wrong row)
//   node __scripts/excludeVote.js \
//     --ballotId 660b... --userId stake1u... \
//     --reason "" --undo --apply

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { loadLocalOverrides } from "../helper/envOverlay.js";
import {
  connectToDatabase,
  disconnectFromDatabase,
} from "../helper/dbManager.js";
import { Vote } from "../schema/Vote.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1];
}

const ballotId = argValue("--ballotId");
const userId = argValue("--userId");
const proposalId = argValue("--proposalId");
const reason = argValue("--reason");
const note = argValue("--note");
const by =
  argValue("--by") || process.env.USER || process.env.LOGNAME || "operator";
const undo = process.argv.includes("--undo");
const apply = process.argv.includes("--apply");

if (!ballotId && !userId && !proposalId) {
  console.error(
    "[excludeVote] need at least one selector: --ballotId, --userId, or --proposalId"
  );
  process.exit(2);
}
if (!undo && (!reason || !reason.trim())) {
  console.error(
    "[excludeVote] --reason is required (e.g. INELIGIBLE_VALIDATION_MISMATCH). Use --undo to clear instead."
  );
  process.exit(2);
}

const filter = {};
if (ballotId) filter.ballotId = ballotId;
if (userId) filter.userId = userId;
if (proposalId) filter.proposalId = proposalId;
// When applying, only target rows that aren't already in the desired
// terminal state — keeps the "matched" count honest on re-runs.
if (apply && !undo) filter.excludedAt = null;
if (apply && undo) filter.excludedAt = { $ne: null };

await connectToDatabase();
try {
  const matched = await Vote.countDocuments(filter);
  console.log(`[excludeVote] selector:`, {
    ballotId: ballotId || "(any)",
    userId: userId || "(any)",
    proposalId: proposalId || "(any)",
  });
  console.log(`[excludeVote] matched rows: ${matched}`);

  if (matched === 0) {
    console.log("[excludeVote] nothing to do");
  } else if (!apply) {
    console.log("[excludeVote] dry-run — re-run with --apply to write");
    // Show a small sample of what would be touched so the operator can
    // sanity-check before flipping --apply.
    const sample = await Vote.find(filter)
      .select("ballotId proposalId userId submittedAt excludedAt excludedReason")
      .limit(5)
      .lean();
    for (const row of sample) {
      console.log(
        `  ${row.ballotId} / ${row.proposalId} / ${row.userId} ` +
          `(submittedAt=${row.submittedAt?.toISOString?.() || row.submittedAt || "null"}, ` +
          `excludedAt=${row.excludedAt?.toISOString?.() || row.excludedAt || "null"})`
      );
    }
    if (matched > sample.length) {
      console.log(`  … +${matched - sample.length} more`);
    }
  } else {
    const update = undo
      ? {
          $set: {
            excludedAt: null,
            excludedReason: null,
            excludedBy: null,
          },
        }
      : {
          $set: {
            excludedAt: new Date(),
            excludedReason: note ? `${reason} — ${note}` : reason,
            excludedBy: by,
          },
        };
    const result = await Vote.updateMany(filter, update);
    console.log(
      `[excludeVote] ${undo ? "cleared" : "flagged"} ${result.modifiedCount} row(s)`
    );
    console.log(
      `[excludeVote] reminder: provisional /results refresh on the next 10-min cron tick. ` +
        `For an immediate refresh run __scripts/recomputeAllResults.js or hit the admin /results/recover endpoint.`
    );
  }
} catch (err) {
  console.error("[excludeVote] failed:", err);
  process.exitCode = 1;
} finally {
  await disconnectFromDatabase();
}
