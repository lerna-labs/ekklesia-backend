import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Vote } from "../schema/Vote.js";
import { Transaction } from "../schema/Transaction.js";
import { Session } from "../schema/Session.js";
import { Comment } from "../schema/Comment.js";
import { Result } from "../schema/Result.js";
import { VoterCache } from "../schema/VoterCache.js";
import { FAQ } from "../schema/FAQ.js";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
    connectToDatabase,
    disconnectFromDatabase,
} from "../helper/dbManager.js";

// Setup environment
let env = "development";

// Get the directory path for relative file references
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables based on the specified environment
const envPath = join(__dirname, "..", `.env.${env}`);
console.log(`Loading environment from: ${envPath}`);
dotenv.config({ path: envPath });

await connectToDatabase();

console.log("Starting database wipe...");
console.time("Database wipe completed in");

// Delete all collections in parallel
try {
    const results = await Promise.all([
        Ballot.deleteMany({}),
        Proposal.deleteMany({}),
        Vote.deleteMany({}),
        Transaction.deleteMany({}),
        Session.deleteMany({}),
        Comment.deleteMany({}),
        Result.deleteMany({}),
        VoterCache.deleteMany({}),
        FAQ.deleteMany({}),
    ]);

    // Log deletion counts
    console.log(`Deleted ${results[0].deletedCount} ballots`);
    console.log(`Deleted ${results[1].deletedCount} proposals`);
    console.log(`Deleted ${results[2].deletedCount} votes`);
    console.log(`Deleted ${results[3].deletedCount} transactions`);
    console.log(`Deleted ${results[4].deletedCount} sessions`);
    console.log(`Deleted ${results[5].deletedCount} comments`);
    console.log(`Deleted ${results[6].deletedCount} results`);
    console.log(`Deleted ${results[7].deletedCount} caches`);
    console.log("All collections wiped successfully.");

    console.timeEnd("Database wipe completed in");
} catch (error) {
    console.error("Error during database wipe:", error);
}

await disconnectFromDatabase();
console.log("Disconnected from database");

process.exit(0);
