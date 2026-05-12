// Backfill Ballot.votingPowerSource on existing docs.
//
// Default for new ballots is { type: "snapshot", scriptName: null }.
// Backfilled rows get scriptName populated from the existing
// voterValidationScript so the cron has a script to call.
//
// Idempotent — only writes ballots that don't already have the field.

import process from "process";
import { Ballot } from "../schema/Ballot.js";
import { connectToDatabase, disconnectFromDatabase } from "../helper/dbManager.js";
import { loadEnvironmentVariables } from "../helper/envLoader.js";
import { loadLocalOverrides } from "../helper/envOverlay.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnvironmentVariables(join(__dirname, ".."));
loadLocalOverrides(join(__dirname, ".."));
await connectToDatabase();

const cursor = Ballot.find({
  $or: [
    { votingPowerSource: { $exists: false } },
    { "votingPowerSource.type": { $exists: false } },
  ],
}).cursor();

let updated = 0;
for await (const ballot of cursor) {
  ballot.votingPowerSource = {
    type: "snapshot",
    scriptName: ballot.voterValidationScript || null,
  };
  await ballot.save();
  updated++;
  console.log(`[backfill] ${ballot._id} ${ballot.title} → snapshot/${ballot.voterValidationScript}`);
}

console.log(`[backfill] updated ${updated} ballot(s)`);
await disconnectFromDatabase();
process.exit(0);
