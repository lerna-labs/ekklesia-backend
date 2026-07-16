/**
 * Creates a test ballot with one proposal, 10 users (mix of DReps and pools) with different
 * voting power, and submits a vote from each user on the proposal.
 *
 * Usage: node __scripts/createTestBallotVoterGroups.js
 * Requires: .env.development (or set NODE_ENV) and MongoDB connection.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

import { Ballot } from '../schema/Ballot.js';
import { Proposal } from '../schema/Proposal.js';
import { Vote } from '../schema/Vote.js';
import { UserCache } from '../schema/UserCache.js';
import { connectToDatabase, disconnectFromDatabase } from '../helper/dbManager.js';
import { Result } from '../schema/Result.js';
import { aggregateVotes } from '../crons/10minAggregateVotes.js';

const LOVELACE_PER_ADA = 1_000_000;

function lovelaceToAda(lovelace) {
  const n = Number(lovelace);
  return (n / LOVELACE_PER_ADA).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const env = process.env.NODE_ENV || 'development';
const envPath = join(__dirname, '..', `.env.${env}`);
dotenv.config({ path: envPath });

const TITLE_PREFIX = 'Test ballot with votes ';

// 10 users: 5 DReps, 5 pools; voting power in lovelace (1 ADA = 1e6 lovelace), half of previous scale
const TEST_USERS = [
  { userId: 'test-drep-1', voterGroup: 'DReps', votingPower: 50_000_000 * LOVELACE_PER_ADA }, // 50M ADA
  { userId: 'test-drep-2', voterGroup: 'DReps', votingPower: 40_000_000 * LOVELACE_PER_ADA }, // 40M ADA
  { userId: 'test-drep-3', voterGroup: 'DReps', votingPower: 25_000_000 * LOVELACE_PER_ADA }, // 25M ADA
  { userId: 'test-drep-4', voterGroup: 'DReps', votingPower: 15_000_000 * LOVELACE_PER_ADA }, // 15M ADA
  { userId: 'test-drep-5', voterGroup: 'DReps', votingPower: 5_000_000 * LOVELACE_PER_ADA }, // 5M ADA
  { userId: 'test-pool-1', voterGroup: 'SPOs', votingPower: 45_000_000 * LOVELACE_PER_ADA }, // 45M ADA
  { userId: 'test-pool-2', voterGroup: 'SPOs', votingPower: 35_000_000 * LOVELACE_PER_ADA }, // 35M ADA
  { userId: 'test-pool-3', voterGroup: 'SPOs', votingPower: 20_000_000 * LOVELACE_PER_ADA }, // 20M ADA
  { userId: 'test-pool-4', voterGroup: 'SPOs', votingPower: 10_000_000 * LOVELACE_PER_ADA }, // 10M ADA
  { userId: 'test-pool-5', voterGroup: 'SPOs', votingPower: 2_500_000 * LOVELACE_PER_ADA }, // 2.5M ADA
];

// Vote option IDs: 1 = Yes, 2 = No, "abstain" = Abstain
const OPTION_YES = 1;
const OPTION_NO = 2;
const OPTION_ABSTAIN = 'abstain';

async function main() {
  await connectToDatabase();

  const now = new Date();
  const voteStart = new Date(now.getTime() - 60 * 60 * 1000);
  const voteEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const runId = now.getTime();

  // 1. Create ballot
  const ballot = new Ballot({
    title: TITLE_PREFIX + runId,
    description: 'Test ballot with one proposal and 10 submitted votes (DReps and pools).',
    ipfsHash: null,
    voterType: 'DReps and SPOs',
    voterDescription: 'Mixed DRep and pool test users',
    voteWeighted: true,
    voteFilters: false,
    votePeriodStart: voteStart,
    votePeriodEnd: voteEnd,
    voteAuthorityId: 'test-authority',
    voteAuthorityAddress: 'addr_test_authority',
    proposalPeriodStart: voteStart,
    proposalPeriodEnd: voteEnd,
    resultTxHash: null,
    voterValidationScript: 'voterValidationAlwaysTrue.js',
    rollupScript: 'rollupBallot.js',
    startupScript: 'startupBallot.js',
    startupAt: now,
    status: 'live',
  });
  await ballot.save();
  console.log('Ballot created:', ballot._id.toString(), ballot.title);

  // 2. Create one proposal (Yes / No). Abstain is allowed by default —
  // voters submit { abstain: true } at the wire boundary without it
  // being listed in voteOptions.
  const proposal = new Proposal({
    ballotId: ballot._id,
    title: 'Test proposal: single choice',
    description: 'One proposal for the test ballot.',
    voteType: 'choice',
    voterBudget: 1,
    voteOptions: [
      { id: OPTION_YES, cost: 1, label: 'Yes' },
      { id: OPTION_NO, cost: 1, label: 'No' },
    ],
  });
  await proposal.save();
  console.log('Proposal created:', proposal._id.toString(), proposal.title);

  // 3. Create UserCache entries for all 10 users
  const userCacheDocs = TEST_USERS.map((u) => ({
    ballotId: ballot._id,
    userId: u.userId,
    validated: true,
    votingPower: u.votingPower,
    voterGroup: u.voterGroup,
  }));
  await UserCache.insertMany(userCacheDocs);
  console.log('UserCache created for 10 users (5 DReps, 5 pools) with varying voting power.');

  // Drop legacy Vote index if present (schema now uses userId; old DBs may have proposalId_1_voterId_1)
  try {
    await Vote.collection.dropIndex('proposalId_1_voterId_1');
    console.log('Dropped legacy Vote index proposalId_1_voterId_1.');
  } catch (e) {
    if (e.code !== 27 && e.codeName !== 'IndexNotFound') throw e;
  }

  // 4. Submit votes: mix of Yes, No, and one Abstain; one vote per user
  const choices = [
    [OPTION_YES],
    [OPTION_YES],
    [OPTION_NO],
    [OPTION_YES],
    [OPTION_NO],
    [OPTION_YES],
    [OPTION_NO],
    [OPTION_YES],
    [OPTION_ABSTAIN],
    [OPTION_NO],
  ];
  const voteDocs = TEST_USERS.map((u, i) => ({
    userId: u.userId,
    ballotId: ballot._id,
    proposalId: proposal._id,
    vote: choices[i],
    submittedVote: choices[i],
    submittedAt: now,
  }));
  await Vote.insertMany(voteDocs);
  console.log('Votes submitted: 10 (mix of Yes, No, Abstain).');

  // 5. Run aggregation immediately so Result has results and resultsByGroup
  console.log('Running vote aggregation...');
  await aggregateVotes();
  console.log('Aggregation complete.');

  // 6. Log results as the frontend should display them
  const resultDoc = await Result.findOne({ proposalId: proposal._id }).lean();
  if (resultDoc?.results) {
    // Dedupe by option id (cron may push an abstain row separately)
    const byOption = new Map();
    for (const r of resultDoc.results) {
      const key = String(r.id);
      const prev = byOption.get(key);
      const vp = Number(r.votingPower || 0);
      const count = Number(r.count || 0);
      if (!prev) byOption.set(key, { id: r.id, label: r.label, votingPower: vp, count });
      else {
        prev.votingPower += vp;
        prev.count += count;
      }
    }
    const results = [...byOption.values()];
    const totalLovelace = results.reduce((sum, r) => sum + r.votingPower, 0);
    const totalVoters = results.reduce((sum, r) => sum + r.count, 0);

    console.log('\n--- Results (frontend display) ---');
    console.log('\nTotal ADA per voting option:');
    for (const r of results) {
      const pct = totalLovelace > 0 ? ((r.votingPower / totalLovelace) * 100).toFixed(1) : '0';
      console.log(
        `  ${r.label}: ${lovelaceToAda(r.votingPower)} ADA (${pct}%) — ${r.count} voter(s)`,
      );
    }
    console.log(`  Total: ${lovelaceToAda(totalLovelace)} ADA — ${totalVoters} voter(s)`);

    if (resultDoc.resultsByGroup && Object.keys(resultDoc.resultsByGroup).length > 0) {
      console.log('\nBy voter group:');
      for (const [groupName, groupData] of Object.entries(resultDoc.resultsByGroup)) {
        const groupTotal =
          groupData.results?.reduce((s, r) => s + Number(r.votingPower || 0), 0) ?? 0;
        const groupVoters = groupData.results?.reduce((s, r) => s + Number(r.count || 0), 0) ?? 0;
        console.log(`  ${groupName}:`);
        for (const r of groupData.results || []) {
          const pct =
            groupTotal > 0 ? ((Number(r.votingPower || 0) / groupTotal) * 100).toFixed(1) : '0';
          console.log(
            `    ${r.label}: ${lovelaceToAda(r.votingPower)} ADA (${pct}%) — ${r.count ?? 0} voter(s)`,
          );
        }
        console.log(`    Total: ${lovelaceToAda(groupTotal)} ADA — ${groupVoters} voter(s)`);
      }
    }
    console.log('--------------------------------\n');
  }

  console.log('Done. Ballot ID:', ballot._id.toString());
  console.log('Proposal ID:', proposal._id.toString());

  await disconnectFromDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
