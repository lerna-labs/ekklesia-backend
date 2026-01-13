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

// exit if validation params isn't set
if (!cliParams.validationScript) {
    console.error("Validation script is required");
    process.exit(1);
}

let validationScript = "voterValidationAlwaysTrue.js";
let voterType = "Stake";
switch (cliParams.validationScript) {
    case "poolPledge":
        validationScript = "voterValidationPoolsPledge.js";
        voterType = "Pools";
        break;
    case "poolStake":
        validationScript = "voterValidationPoolsStake.js";
        voterType = "Pools";
        break;
    case "dreps":
        validationScript = "voterValidationDReps.js";
        voterType = "DReps";
        break;
    case "stake":
        validationScript = "voterValidationStake.js";
        voterType = "Stake";
        break;
    default:
        console.error("Invalid validation script");
        process.exit(1);
}

// set vote period start and end to 1 day from now
let votePeriodStart = new Date();
let votePeriodEnd = new Date();
votePeriodEnd.setDate(votePeriodEnd.getDate() + 1);

// console logs
console.log("Vote period start:", votePeriodStart);
console.log("Vote period end:", votePeriodEnd);
console.log("Validation script:", validationScript);
console.log("Voter type:", voterType);

// create a new ballot
const ballot = new Ballot({
    title: "Test Ballot: " + cliParams.validationScript,
    description: "This is a test ballot for the " + validationScript + " validation script.",
    voterType: voterType,
    voterDescription: "Cardano DReps",
    votePeriodStart,
    votePeriodEnd,
    voteAuthorityId: `authority-${Math.floor(Math.random() * 1000)}`,
    voteAuthorityAddress: `address-${Math.floor(Math.random() * 1000)}`,
    proposalPeriodStart: new Date(),
    proposalPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
    voterValidationScript: validationScript,
    rollupScript: "rollupBallot.js",
    voteWeighted: true,
    voteFilters: true,
    voteThreshold: 0,
    resultBeaconToken: null,
});

// save ballot to db
await ballot.save();
console.log("Ballot created successfully", ballot._id);

const newProposal = new Proposal({
    title: "Budget Proposal",
    ballotId: ballot._id,
    description: "A budget proposal, total cost is 3, all items are equally costed at 1.",
    data: {
        collapsible: {
            title: "Information",
            content: "Below are the items for the budget proposal. Each item includes a brief description and a link to more detailed information. Please review these items to inform your voting decisions.",
            items:
                [
                    {
                        "id": 1,
                        "title": "Avocado",
                        "content": "Avocado is a fruit.",
                        "link": "https://avocado.com",
                        "cost": 1
                    },
                    {
                        "id": 2,
                        "title": "Banana",
                        "content": "A Banana is a fruit.",
                        "link": "https://intersect.gitbook.io/executive-director-hiring/candidates/Andrea",
                        "cost": 1
                    },
                    {
                        "id": 3,
                        "title": "Cabbage",
                        "content": "Cabbage is a vegetable.",
                        "link": "https://cabbage.com",
                        "cost": 1
                    },
                    {
                        "id": 4,
                        "title": "Daikon",
                        "content": "Daikon is a root vegetable.",
                        "link": "https://daikon.com",
                        "cost": 1
                    },
                    {
                        "id": 5,
                        "title": "Eggplant",
                        "content": "Eggplant is a vegetable.",
                        "link": "https://eggplant.com",
                        "cost": 1
                    },
                ],
        },
        links: [
            { name: "Process Overview and Information", url: "https://intersect.gitbook.io/executive-director-hiring" }
        ]
    },
    voteType: "budget",
    voterBudget: 3,
    voteOptions: [
        {
            "id": 1,
            "label": "Avocado",
            "cost": 1
        },
        {
            "id": 2,
            "label": "Banana",
            "cost": 1
        },
        {
            "id": 3,
            "label": "Cabbage",
            "cost": 1
        },
        {
            "id": 4,
            "label": "Daikon",
            "cost": 1
        },
        {
            "id": 5,
            "label": "Eggplant",
            "cost": 1
        },
    ],
});
await newProposal.save();
console.log("Proposal created successfully:", newProposal._id);








// disconnect from db
await disconnectFromDatabase();
process.exit(0);