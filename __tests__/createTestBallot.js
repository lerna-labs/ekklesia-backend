import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import {
    connectToDatabase,
    disconnectFromDatabase,
} from "../helper/dbManager.js";
import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
// Get the directory path for relative file references
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// setup environment
let env = "development";

// Load environment variables based on the specified environment
const envPath = join(__dirname, "..", `.env.${env}`);
console.log(`Loading environment from: ${envPath}`);
dotenv.config({ path: envPath });

// connect to db
await connectToDatabase();

// get cli params
const cliArgs = process.argv.slice(2); // Skip 'node' and script name
const cliParams = {};

// Parse CLI arguments into JSON object
// Supports formats: --key value, --key=value, -k value, -k=value
for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];

    // Handle --key=value or -k=value format
    if (arg.includes('=')) {
        const [key, ...valueParts] = arg.split('=');
        const value = valueParts.join('='); // Handle values that contain '='
        const cleanKey = key.replace(/^--?/, ''); // Remove -- or -
        cliParams[cleanKey] = value;
    }
    // Handle --key value or -k value format
    else if (arg.startsWith('--') || arg.startsWith('-')) {
        const cleanKey = arg.replace(/^--?/, '');
        // Check if next argument exists and is not a flag
        if (i + 1 < cliArgs.length && !cliArgs[i + 1].startsWith('-')) {
            cliParams[cleanKey] = cliArgs[i + 1];
            i++; // Skip next argument as it's the value
        } else {
            // Flag without value, set to true
            cliParams[cleanKey] = true;
        }
    }
    // Handle positional arguments
    else {
        if (!cliParams._positional) {
            cliParams._positional = [];
        }
        cliParams._positional.push(arg);
    }
}
console.log('CLI Parameters:', JSON.stringify(cliParams, null, 2));

// exit if validation params isn't set


let validationScript = "voterValidationAlwaysTrue.js";
switch (cliParams.validationScript) {
    case "poolPledge":
        validationScript = "voterValidationPoolsPledge.js";
        break;
    case "poolStake":
        validationScript = "voterValidationPoolsStake.js";
        break;
    case "drep":
        validationScript = "voterValidationDReps.js";
        break;
    case "stake":
        validationScript = "voterValidationStake.js";
        break;
    default:
        console.error("Invalid validation script");
        process.exit(1);
}


// set vote period start and end to 1 day from now
let votePeriodStart = new Date();
let votePeriodEnd = new Date();
votePeriodEnd.setDate(votePeriodEnd.getDate() + 1);

// // create a new ballot
// const ballot = new Ballot({
//     title: "Intersect Executive Director - Poll",
//     description:
//         "As part of the executive director (ED) recruitment process, DReps are invited to take part in a poll to provide insights to determine which candidates advance to panel interviews. This ensures that the appointment reflects also DRep sentiment.",
//     voterType: "DReps",
//     voterDescription: "Cardano DReps",
//     votePeriodStart,
//     votePeriodEnd,
//     voteAuthorityId: `authority-${Math.floor(Math.random() * 1000)}`,
//     voteAuthorityAddress: `address-${Math.floor(Math.random() * 1000)}`,
//     proposalPeriodStart: new Date(),
//     proposalPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
//     voterValidationScript: "voterValidationIntersectVoteLive.js",
//     rollupScript: "rollupBallot.js",
//     voteWeighted: true,
//     voteFilters: true,
//     voteThreshold: 0,
//     resultBeaconToken: null,
// });

// await ballot.save();