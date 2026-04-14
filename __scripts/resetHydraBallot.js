// Reset Hydra ballot state on the BACKEND side.
//
// Single ballot:
//   --ballotId <oid>          target one ballot by Mongo _id
//   --title '<title>'         target one ballot by exact title
//   --clear                   default — keep Ballot doc, null out Hydra fields
//   --delete                  remove Ballot doc + its Proposals
//
// Bulk:
//   --all-hydra               every Ballot where source === "hydra"
//   --all                     every Ballot (legacy + hydra) — test-only
//   --confirm                 required for --all / --all-hydra to prevent
//                             accidental prod wipes
//
// All modes also delete the ballot's VotePackages + Votes and null the
// UserCache.nonce rows. Does NOT touch Hydra-side state. For a full wipe,
// pair with:
//   1. node __scripts/sweepAdminWallet.js   (clean admin wallet)
//   2. curl -X POST …/close                 (if a Hydra head is open)
//   3. Operator restart of the Hydra middleware + hydra-node persistence
//      dir wipe if /start still reports a ghost-open head
//
// Usage:
//   node __scripts/resetHydraBallot.js --ballotId 69dd5b6...
//   node __scripts/resetHydraBallot.js --title 'Scaffold/hydra/dreps/live#001' --delete
//   node __scripts/resetHydraBallot.js --all-hydra --delete --confirm
//   node __scripts/resetHydraBallot.js --all --delete --confirm

import process from "process";
import mongoose from "mongoose";
import { bootstrap, teardown, parseArgs } from "./scaffold/common/env.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Vote } from "../schema/Vote.js";
import { VotePackage } from "../schema/VotePackage.js";
import { UserCache } from "../schema/UserCache.js";

const { flags } = parseArgs();
const deleteBallot = Boolean(flags.delete);
const bulkHydra = Boolean(flags["all-hydra"]);
const bulkAll = Boolean(flags.all);
const bulk = bulkHydra || bulkAll;

await bootstrap();

// Build a filter that selects the target ballot(s).
let filter = null;
if (flags.ballotId) {
  if (!mongoose.isValidObjectId(flags.ballotId)) {
    console.error(`Invalid ballotId: ${flags.ballotId}`);
    await teardown();
    process.exit(1);
  }
  filter = { _id: new mongoose.Types.ObjectId(flags.ballotId) };
} else if (flags.title) {
  filter = { title: flags.title };
} else if (bulkHydra) {
  filter = { source: "hydra" };
} else if (bulkAll) {
  filter = {};
} else {
  console.error(
    "Pass --ballotId <oid> / --title '<title>' / --all-hydra / --all"
  );
  await teardown();
  process.exit(1);
}

if (bulk && !flags.confirm) {
  console.error(
    "--all-hydra and --all are destructive across every matching ballot. " +
      "Re-run with --confirm to proceed."
  );
  await teardown();
  process.exit(1);
}

const ballots = await Ballot.find(filter).select("_id title source").lean();
if (ballots.length === 0) {
  console.log(`[reset] no ballots matched ${JSON.stringify(filter)}`);
  await teardown();
  process.exit(0);
}

const ids = ballots.map((b) => b._id);
console.log(`[reset] matched ${ballots.length} ballot(s):`);
for (const b of ballots.slice(0, 10)) console.log(`  - ${b.title} (${b._id}, source=${b.source})`);
if (ballots.length > 10) console.log(`  … and ${ballots.length - 10} more`);
console.log(`[reset] mode  : ${deleteBallot ? "DELETE (doc + proposals)" : "CLEAR (keep doc, reset Hydra fields)"}`);

// Vote state — always wiped, regardless of --clear vs --delete
const pkgs = await VotePackage.deleteMany({ ballotId: { $in: ids } });
console.log(`[reset] VotePackage removed: ${pkgs.deletedCount}`);

const votes = await Vote.deleteMany({ ballotId: { $in: ids } });
console.log(`[reset] Vote removed       : ${votes.deletedCount}`);

const caches = await UserCache.updateMany(
  { ballotId: { $in: ids } },
  { $set: { nonce: null } }
);
console.log(`[reset] UserCache nonces reset: ${caches.modifiedCount}`);

if (deleteBallot) {
  const props = await Proposal.deleteMany({ ballotId: { $in: ids } });
  console.log(`[reset] Proposal removed   : ${props.deletedCount}`);
  const bal = await Ballot.deleteMany({ _id: { $in: ids } });
  console.log(`[reset] Ballot removed     : ${bal.deletedCount}`);
} else {
  const clr = await Ballot.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        hydraEndpoint: null,
        hydraHeadId: null,
        hydraHeadStatus: null,
        ballotCid: null,
        instancePolicyId: null,
        definitionAssetName: null,
        instanceAssetName: null,
        ballotFingerprint: null,
        timelockSlot: null,
        commitUtxos: [],
      },
    }
  );
  console.log(`[reset] Ballot docs cleared: ${clr.modifiedCount}`);
}

await teardown();
process.exit(0);
