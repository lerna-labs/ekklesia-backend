// !! add a lock to prevent multiple instances of this script from running at the same time
// only needed on large scale votes

// Conosole log
console.log("Starting 10min cron job...");

// Load environment variables first
import { loadEnvironmentVariables } from "../helper/envLoader.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from project root
// Assuming project root is two directories up from the crons folder
try {
  loadEnvironmentVariables(path.resolve(__dirname, ".."));
} catch (error) {
  console.warn(`Error loading environment variables: ${error.message}`);
  process.exit(1);
}

// Import necessary modules
import {
  isDatabaseConnected,
  connectToDatabase,
  disconnectFromDatabase,
} from "../helper/dbManager.js";
import { Ballot } from "../schema/Ballot.js";
import { aggregateVotes } from "./10minAggregateVotes.js";
import { snapshotVotingPower } from "./15minVotingPower.js";

// connect db
if (!isDatabaseConnected()) {
  await connectToDatabase();
}

// run startup script for ballots that start in the next 10 minutes
let now = new Date();

// get all ballots that start in the next 10 minutes
const ballotsStart = await Ballot.find({
  votePeriodStart: { $gte: now, $lt: new Date(now.getTime() + 10 * 60 * 1000) },
  startupAt: null,
});

const { loadValidationScript } = await import("../helper/loadValidationScript.js");

// process each ballot
for (const ballot of ballotsStart) {
  const { startupBallot } = await loadValidationScript(ballot.startupScript);
  // run startup script
  const startupResult = await startupBallot(ballot._id);
  // update ballot status to live
  if (startupResult == true) {
    await Ballot.updateOne({ _id: ballot._id }, { $set: { startupAt: now } });
  } else {
    console.error("STARTUP: Ballot", ballot._id, "failed");
  }
  console.log("STARTUP: Ballot", ballot._id, "completed");
}
// aggregate votes
await aggregateVotes();

// refresh per-voter voting-power snapshots for snapshot-mode ballots.
// Skipped for ballots whose source has transitioned to "uploaded".
try {
  await snapshotVotingPower();
} catch (err) {
  console.error("snapshotVotingPower failed:", err);
}

// ballot rollup 
// !! this is not live yet and needs proper testing and rewriting - if automated rollups are even a thing
// get all ballots that ended in the last 10 minutes
// reset timestamp in case the former scripts run too long
now = new Date();
const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
const ballotsClosed = await Ballot.find({
  votePeriodEnd: { $gte: tenMinutesAgo, $lt: now },
  resultTxHash: null,
});

// process each ballot
for (const ballot of ballotsClosed) {
  console.log("ROLLUP: Ballot", ballot.name);
  // import finalization script
  const { rollupBallot } = await loadValidationScript(ballot.rollupScript);
  // run finalization script
  await rollupBallot(ballot._id);
}

// disconnect from db
await disconnectFromDatabase();

// Conosole log
console.log("Finished 10min cron job.");
process.exit(0);
