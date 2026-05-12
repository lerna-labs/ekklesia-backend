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


let validationScript = "voterValidationSnapshot.js";
let voterType = "Stake";

// set vote period start to 15 minutes from now and end to 1 day from now
let votePeriodStart = new Date(Date.now() + 5 * 60 * 1000);
let votePeriodEnd = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);

// console logs
console.log("Vote period start:", votePeriodStart);
console.log("Vote period end:", votePeriodEnd);
console.log("Validation script:", validationScript);
console.log("Voter type:", voterType);

// create a new ballot
const ballot = new Ballot({
    title: "Cardano Reward Sharing Scheme v2",
    description: "Ballot organized by the Cardano Incentives Working Group (CIWG), an independent volunteer collective of community members researching improvements to Cardano’s Reward Sharing Scheme (RSS). This ballot collects community signal on proposed incentive changes and initial parameter values for potential inclusion in a future hard fork.\n\nCardano DReps vote using their delegated voting power, SPOs vote using their pledge.\n\n**More info:**\n- [https://cerkoryn.gitbook.io/rssv2/](https://cerkoryn.gitbook.io/rssv2/)\n- [https://incentives.solutions](https://incentives.solutions)",
    voterType: "DReps (delegation based) & SPOs (pledge based)",
    voterDescription: "Cardano dReps vote using their delegated voting power, SPOs vote using their pledge.",
    voteWeighted: true,
    votePeriodStart,
    votePeriodEnd,
    voteAuthorityId: `authority-${Math.floor(Math.random() * 1000)}`,
    voteAuthorityAddress: `address-${Math.floor(Math.random() * 1000)}`,
    proposalPeriodStart: new Date(),
    proposalPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
    voterValidationScript: "voterValidationSnapshot.js",
    rollupScript: "rollupBallot.js",
    startupScript: "startupIncentiveVote.js",
    voteFilters: true,
});

// save ballot to db
await ballot.save();
console.log("Ballot created successfully", ballot._id);

const proposal1 = new Proposal({
    title: "1) Adopt CIP-50 — Pledge Leverage-Based Staking Rewards",
    ballotId: ballot._id,
    description: "Introduces a new parameter L to cap a pool’s effective stake relative to its pledge, discouraging highly under-pledged / split pools and aiming to improve sybil resistance and decentralization without penalizing well-pledged small pools.",
    data: {
        links: [
            { name: "CIP-50 text", url: "https://cips.cardano.org/cip/CIP-50" },
            { name: "CIP-50 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1042" },
            { name: "CIP-50 Cardano Forum Discussion", url: "https://forum.cardano.org/t/cip-0050-pledge-leverage-based-staking-rewards" },
            { name: "CIP-50 RSS Simulation Engine Pull Request", url: "https://github.com/Blockchain-Technology-Lab/Rewards-Sharing-Simulation-Engine/pull/11" },
            { name: "Cardano Foundation CIP-50 Table Talk", url: "https://www.youtube.com/live/dGymb5wCX8Y" },
            { name: "Parameter Committee CIP-50 Presentation", url: "https://docs.google.com/presentation/d/1foroY6UjFRyCicKE8QkrOpDgqS5_NrS-qN6u6HHhWHA" },
            { name: "CIP-50 Modeling (select CIP-50 under formula and adjust L slider)", url: "https://spo-incentives.vercel.app" },
            { name: "CIP-50 FAQ", url: "https://incentives.solutions/cip-50-faq" },
        ]
    },
    voteType: "choice",
    voteBudget: 1,
    voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
    ],
});


const proposal2 = new Proposal({
    title: "2) Initial value of new “L” parameter for CIP-50",
    ballotId: ballot._id,
    description: "**L** is a new protocol parameter that represents a pool’s pledge leverage (stake-to-pledge ratio) used when computing a pool’s eligible stake in rewards. If a pool exceeds the limit set by this value (**L** times the pool’s pledge), any stake over the limit is treated as oversaturated and does not contribute additional rewards.\n\nFor example, if L is set to 1000 and a pool has 10k ADA in pledge, then that pool can support up to 10M ADA in stake(1000 * 10k) before becoming oversaturated.If that pool increased their pledge to 100k, then that would amount to 100M ADA in stake(1000 * 100k).However, at that point they would be limited by the global saturation cap set by the **k** parameter which is currently around 71.7M ADA.",
    data: {
        links: [
            { name: "CIP-50 Modeling (select CIP-50 under formula and adjust L slider)", url: "https://spo-incentives.vercel.app/" },
            { name: "Chart showing Stake/Wallets affected by values of L (snapshot from 15 October, 2025)", url: "https://raw.githubusercontent.com/Cerkoryn/governance-reference/refs/heads/main/L_values.png" },
        ]
    },
    voteType: "scale",
    voteIncrement: 1,
    voteBudget: 1,
    voteOptions: [
        { id: 150, cost: 1, label: "150" },
        { id: 2500, cost: 1, label: "2500" },
    ],
});

const proposal3 = new Proposal({
    title: "3) Adopt CIP-163 — Time-Bound Delegation with Dynamic Rewards",
    ballotId: ballot._id,
    description: "Introduces a new parameter **delegatorInactivity**, measured in epochs, as a proof-of-life for each wallet delegated to a stake pool or dRep.  Expired (inactive) wallets don’t earn rewards or contribute voting power until they are reactivated. Additionally, the full rewards pot is distributed among eligible participants instead of returning a portion to the reserve during rewards calculation.",
    data: {
        links: [
            { name: "CIP-163 text", url: "https://cips.cardano.org/cip/CIP-163" },
            { name: "CIP-163 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1077" },
            { name: "CIP-163 Cardano Forum Discussion", url: "https://forum.cardano.org/t/cip-0163-time-bound-delegation-with-dynamic-rewards" },
            { name: "Cardano Foundation CIP-163 Seminar", url: "https://youtu.be/zxcuOqHe7zA" },
            { name: "Cardano Foundation CIP-163 Seminar Slides", url: "https://docs.google.com/presentation/d/1m_s0yymahQjyE21s1VgC6CgYC0K4mjP2YgjnIGzUhNo" },
            { name: "CIP-163 Modeling (select CIP-163 under rewards and adjust Staked Ratio & k sliders)", url: "https://spo-incentives.vercel.app" },
            { name: "CIP-163 FAQ", url: "https://incentives.solutions/cip-163-faq" },
        ]
    },
    voteType: "choice",
    voteBudget: 1,
    voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
    ],
});

const proposal4 = new Proposal({
    title: "4) Initial value of new “delegatorInactivity” parameter for CIP-163",
    ballotId: ballot._id,
    description: "**delegatorInactivity** is the number of epochs a wallet can go without making a transaction before it becomes ineligible for rewards/governance.  Any transaction that records a witness from the wallet’s stake credential will refresh the **delegatorInactivity** duration for that wallet.  This change will be applied retroactively.",
    data: {
        links: [
            { name: "CIP-163 Modeling (select CIP-163 under rewards and adjust Staked Ratio & k sliders)", url: "https://spo-incentives.vercel.app" },
            { name: "CIP-163 Inactive Stake by Pool Search", url: "https://earncoinpool.com/CIP-163.html" },
            {
                name: "Chart showing Stake/Wallets affected by values of delegatorInactivity (snapshot from 15 October, 2025)", url: "https://raw.githubusercontent.com/Cerkoryn/governance-reference/refs/heads/main/delegatorInactivity_values.jpg"
            },
        ]
    },
    voteType: "scale",
    voteIncrement: 1,
    voteBudget: 1,
    voteOptions: [
        { id: 73, cost: 1, label: "73 Epochs" },
        { id: 438, cost: 1, label: "438 Epochs" },
    ],
});

const proposal5 = new Proposal({
    title: "5) Initial value of new “minPoolMargin” parameter for CIP-23",
    ballotId: ballot._id,
    description: "Introduces a new parameter **minPoolMargin** that represents the minimum variable fee that a pool can set.  This parameter could be used instead of the existing **minPoolCost** parameter that represents the minimum per-epoch fixed fee a pool can set.  The expectation is to make fees fairer for delegators to smaller pools and reduce centralization pressure.\n\n**Note:** This proposal introduces the new parameter **minPoolMargin** but does not eliminate **minPoolCost**.",
    data: {
        links: [
            { name: "CIP-23 text", url: "https://cips.cardano.org/cip/CIP-23" },
            { name: "CIP-23 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1086" },
            { name: "CIP-23 Cardano Forum Discussion", url: "https://forum.cardano.org/t/cip-0023-fair-min-fees" },
            { name: "CIP-23 Misconceptions", url: "https://incentives.solutions/misconception-pool-min-fee-is-applied-to-all-blocks-in-an-epoch" },
        ]
    },
    voteType: "scale",
    voteIncrement: 1,
    voteBudget: 1,
    voteOptions: [
        { id: 0, cost: 1, label: "0%" },
        { id: 50, cost: 1, label: "50%" },
    ],
});
await proposal5.save();
console.log("Proposal created successfully:", proposal5._id);

await proposal4.save();
console.log("Proposal created successfully:", proposal4._id);

await proposal3.save();
console.log("Proposal created successfully:", proposal3._id);

await proposal2.save();
console.log("Proposal created successfully:", proposal2._id);

await proposal1.save();
console.log("Proposal created successfully:", proposal1._id);

// disconnect from db
await disconnectFromDatabase();
process.exit(0);