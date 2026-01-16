// Conosole log
console.log("Starting 1min cron job...");

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

import {
    isDatabaseConnected,
    connectToDatabase,
    disconnectFromDatabase,
} from "../helper/dbManager.js";
import { Ballot } from "../schema/Ballot.js";

// connect db
if (!isDatabaseConnected()) {
    await connectToDatabase();
}

// close all ballots where the voting period ended
const ballotsLive = await Ballot.find({ status: "live", votePeriodEnd: { $lte: new Date() } });
for (const ballot of ballotsLive) {
    await Ballot.updateOne({ _id: ballot._id }, { $set: { status: "closed" } });
    console.log("1MIN: Ballot", ballot.name, "closed");
}

// set upcoming ballots to live if startupAt is not null
const ballotsUpcoming = await Ballot.find({
    status: "upcoming",
    votePeriodStart: { $lte: new Date() },
    startupAt: { $ne: null }
});
for (const ballot of ballotsUpcoming) {
    await Ballot.updateOne({ _id: ballot._id }, { $set: { status: "live" } });
    console.log("1MIN: Ballot", ballot.name, "set to live");
}

// disconnect from db
await disconnectFromDatabase();

// Conosole log
console.log("Finished 1min cron job.");
process.exit(0);
