// One-time data fix for Vote documents created before the
// voterId → userId schema rename (commit 80e8636, Feb 28 2026).
//
// Context: the rename touched code paths and Mongoose schema, but no
// data migration was ever run. Production instances (notably Intersect)
// still have Vote docs with the original `voterId` field and no
// `userId`. The aggregation in routes/api/v0/voters.js groups by
// `$userId`, which collapses every legacy row into a single `_id: null`
// bucket — the "100 votes by userId: null" row the voter directory
// surfaces.
//
// This script does four things, idempotently — order matters:
//
//   1. Drop obsolete indexes left behind by the rename:
//        votes.voterId_1
//        votes.proposalId_1_voterId_1   (the old uniqueness guard)
//        sessions.voterId_1             (Session schema dropped voterId
//                                        long ago; index was orphaned)
//      The old UNIQUE index has to go FIRST — $rename drops the
//      `voterId` field from every doc, which Mongo evaluates as
//      `voterId: null` against the still-live unique index and refuses
//      to update past the first doc (E11000 duplicate key).
//   2. Rename `voterId` → `userId` on every Vote doc that still has
//      the legacy field and no userId set.
//   3. Create the current Vote schema's `proposalId_1_userId_1` UNIQUE
//      index if it's missing (Mongoose can't replace an index on its
//      own — it leaves the old one alone and never creates the new one
//      while a name conflict / shape disagreement is unresolved).
//   4. Print a summary so the operator can spot-check before/after.
//
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node __scripts/backfillVoteUserId.js          # report only
//   node __scripts/backfillVoteUserId.js --apply  # rename + reindex

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
import { Session } from "../schema/Session.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const apply = process.argv.includes("--apply");

await connectToDatabase();
try {
  // Hit the raw driver collection — Mongoose's strictQuery would strip
  // `voterId` out of filters because it's no longer in the schema.
  const votesColl = Vote.collection;
  const sessionsColl = Session.collection;

  // --- Phase 1: count legacy rows ---
  const totalVotes = await votesColl.countDocuments({});
  const legacyCount = await votesColl.countDocuments({
    voterId: { $exists: true },
    userId: { $exists: false },
  });
  const mixedCount = await votesColl.countDocuments({
    voterId: { $exists: true },
    userId: { $exists: true },
  });
  console.log(`[backfill] votes total:               ${totalVotes}`);
  console.log(`[backfill] votes (voterId only):      ${legacyCount}`);
  console.log(`[backfill] votes (both fields):       ${mixedCount}`);

  // Report current index state up front so dry-runs are useful.
  const voteIndexes = await votesColl.indexes();
  const has = (name) => voteIndexes.some((i) => i.name === name);
  console.log(
    `[backfill] votes.voterId_1:                ${has("voterId_1") ? "present (stale)" : "absent"}`
  );
  console.log(
    `[backfill] votes.proposalId_1_voterId_1:   ${has("proposalId_1_voterId_1") ? "present (stale)" : "absent"}`
  );
  console.log(
    `[backfill] votes.proposalId_1_userId_1:    ${has("proposalId_1_userId_1") ? "present" : "absent"}`
  );
  const sessionIndexes = await sessionsColl.indexes();
  const sessionsHasVoterId = sessionIndexes.some(
    (i) => i.name === "voterId_1"
  );
  console.log(
    `[backfill] sessions.voterId_1:             ${sessionsHasVoterId ? "present (stale)" : "absent"}`
  );

  if (!apply) {
    console.log("[backfill] dry-run — re-run with --apply to write");
  } else {
    // --- Phase 2a: drop the old uniqueness guard FIRST ---
    //
    // The unique index `(proposalId, voterId)` evaluates against the
    // post-update doc state. After $rename strips `voterId`, every doc
    // collapses to `voterId: null` and the unique index refuses the
    // second update (E11000). Drop before renaming. Same for the
    // single-field voterId_1 — keeping it would waste a B-tree on a
    // field nothing reads or writes anymore.
    if (has("voterId_1")) {
      await votesColl.dropIndex("voterId_1");
      console.log("[backfill] dropped index votes.voterId_1");
    }
    if (has("proposalId_1_voterId_1")) {
      await votesColl.dropIndex("proposalId_1_voterId_1");
      console.log("[backfill] dropped index votes.proposalId_1_voterId_1");
    }
    if (sessionsHasVoterId) {
      await sessionsColl.dropIndex("voterId_1");
      console.log("[backfill] dropped index sessions.voterId_1");
    }

    // --- Phase 2b: rename ---
    if (legacyCount > 0) {
      // $rename only runs where voterId exists AND userId does not — so
      // rows that already migrated are skipped automatically. Rows that
      // somehow ended up with both fields are NOT renamed (mixedCount
      // above surfaces the count so an operator can investigate
      // manually before they clobber a real userId).
      const result = await votesColl.updateMany(
        { voterId: { $exists: true }, userId: { $exists: false } },
        { $rename: { voterId: "userId" } }
      );
      console.log(
        `[backfill] renamed voterId → userId on ${result.modifiedCount} Vote doc(s)`
      );
    }

    // --- Phase 3: re-add the current uniqueness guard ---
    const after = await votesColl.indexes();
    if (!after.some((i) => i.name === "proposalId_1_userId_1")) {
      await votesColl.createIndex(
        { proposalId: 1, userId: 1 },
        { unique: true, name: "proposalId_1_userId_1" }
      );
      console.log(
        "[backfill] created index votes.proposalId_1_userId_1 UNIQUE"
      );
    }
  }
} finally {
  await disconnectFromDatabase();
}
