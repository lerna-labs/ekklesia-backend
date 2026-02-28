/**
 * Integration test: vote aggregation with voter groups (results + resultsByGroup).
 * Requires MongoDB. Loads .env.development; uses MONGODB_URI_TEST or MONGODB_URI if set,
 * otherwise builds URI from MONGODB_HOST/PORT/DATABASE (with test DB name). Skips suite when no URI can be resolved.
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.development") });

function getMongoUri() {
  if (process.env.MONGODB_URI_TEST || process.env.MONGODB_URI) {
    return process.env.MONGODB_URI_TEST || process.env.MONGODB_URI;
  }
  const database = process.env.MONGODB_DATABASE;
  if (!database) return null;
  const host = process.env.MONGODB_HOST || "localhost";
  const port = process.env.MONGODB_PORT || "27017";
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const authSource = process.env.MONGODB_AUTH_SOURCE || "admin";
  const dbName = process.env.MONGODB_DATABASE_TEST || `${database}_test`;
  let uri = "mongodb://";
  if (username && password) {
    uri += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  uri += `${host}:${port}/${dbName}`;
  if (username && password) uri += `?authSource=${authSource}`;
  return uri;
}

import mongoose from "mongoose";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Vote } from "../schema/Vote.js";
import { VoterCache } from "../schema/VoterCache.js";
import { Result } from "../schema/Result.js";
import { aggregateVotes } from "../crons/10minAggregateVotes.js";

const BALLOT_TITLE_PREFIX = "Test grouped aggregation ";
const mongoUri = getMongoUri();

function makeBallot(title) {
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    title,
    description: "Test ballot for grouped aggregation",
    voterType: "test",
    voterDescription: "Test voters",
    voteWeighted: true,
    voteFilters: false,
    votePeriodStart: now,
    votePeriodEnd: later,
    proposalPeriodStart: now,
    proposalPeriodEnd: later,
    voteAuthorityId: "test-authority",
    voteAuthorityAddress: "addr_test_authority",
    status: "live",
  };
}

function makeProposal(ballotId, options = {}) {
  const { abstainAllowed = false, voteOptions } = options;
  const defaultOptions = [
    { id: 1, cost: 1, label: "Yes" },
    { id: 2, cost: 1, label: "No" },
  ];
  if (abstainAllowed) {
    defaultOptions.push({ id: "abstain", label: "Abstain" });
  }
  return {
    ballotId,
    title: "Test proposal",
    description: "Test",
    voteType: "default",
    voteOptions: voteOptions || defaultOptions,
    abstainAllowed,
  };
}

function makeVoterCaches(ballotId, list) {
  return list.map(({ userId, voterGroup, votingPower }) => ({
    ballotId,
    userId,
    voterGroup,
    votingPower,
    validated: true,
  }));
}

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("aggregateVotes grouped results", () => {
  const runId = Date.now();

  beforeAll(async () => {
    if (!mongoUri) return;
    mongoose.set("strictQuery", true);
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    if (!mongoUri) return;
    try {
      const ballots = await Ballot.find({ title: new RegExp("^" + BALLOT_TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + runId) }).lean();
      const ballotIds = ballots.map((b) => b._id);
      const proposals = await Proposal.find({ ballotId: { $in: ballotIds } }).lean();
      const proposalIds = proposals.map((p) => p._id);

      if (proposalIds.length > 0) {
        await Vote.deleteMany({ proposalId: { $in: proposalIds } });
        await Result.deleteMany({ proposalId: { $in: proposalIds } });
      }
      if (ballotIds.length > 0) {
        await VoterCache.deleteMany({ ballotId: { $in: ballotIds } });
        await Proposal.deleteMany({ ballotId: { $in: ballotIds } });
        await Ballot.deleteMany({ _id: { $in: ballotIds } });
      }
    } finally {
      await mongoose.disconnect();
    }
  });

  test("two groups (drep/pool): overall and resultsByGroup", async () => {
    const ballot = await Ballot.create(makeBallot(BALLOT_TITLE_PREFIX + runId));
    const proposal = await Proposal.create(makeProposal(ballot._id, { abstainAllowed: false }));

    const drepVoters = [10, 20, 30, 40, 50].map((power, i) => ({
      userId: `voter-drep-${i + 1}`,
      voterGroup: "drep",
      votingPower: power,
    }));
    const poolVoters = [1, 2, 3, 4, 5].map((power, i) => ({
      userId: `voter-pool-${i + 1}`,
      voterGroup: "pool",
      votingPower: power,
    }));
    await VoterCache.insertMany(makeVoterCaches(ballot._id, [...drepVoters, ...poolVoters]));

    const votes = [
      { userId: "voter-drep-1", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-2", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-3", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-4", submittedVote: [2], vote: [2] },
      { userId: "voter-drep-5", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-1", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-2", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-3", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-4", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-5", submittedVote: [2], vote: [2] },
    ].map((v) => ({
      ballotId: ballot._id,
      proposalId: proposal._id,
      ...v,
      submittedAt: new Date(),
    }));
    await Vote.insertMany(votes);

    await aggregateVotes();

    const result = await Result.findOne({ proposalId: proposal._id }).lean();
    expect(result).not.toBeNull();
    expect(result.results).toBeDefined();
    const yes = result.results.find((r) => r.id === 1);
    const no = result.results.find((r) => r.id === 2);
    expect(yes).toEqual({ id: 1, label: "Yes", count: 5, votingPower: 63 });
    expect(no).toEqual({ id: 2, label: "No", count: 5, votingPower: 102 });

    expect(result.resultsByGroup).toBeDefined();
    const drep = result.resultsByGroup.drep;
    const pool = result.resultsByGroup.pool;
    expect(drep).toBeDefined();
    expect(drep.results).toBeDefined();
    expect(drep.totalVotes).toBe(5);
    expect(drep.results.find((r) => r.id === 1)).toEqual({ id: 1, label: "Yes", count: 3, votingPower: 60 });
    expect(drep.results.find((r) => r.id === 2)).toEqual({ id: 2, label: "No", count: 2, votingPower: 90 });

    expect(pool).toBeDefined();
    expect(pool.results).toBeDefined();
    expect(pool.totalVotes).toBe(5);
    expect(pool.results.find((r) => r.id === 1)).toEqual({ id: 1, label: "Yes", count: 2, votingPower: 3 });
    expect(pool.results.find((r) => r.id === 2)).toEqual({ id: 2, label: "No", count: 3, votingPower: 12 });
  });

  test("abstain vote: abstain in results and in drep group", async () => {
    const ballot = await Ballot.create(makeBallot(BALLOT_TITLE_PREFIX + runId + " abstain"));
    const proposal = await Proposal.create(makeProposal(ballot._id, { abstainAllowed: true }));

    const drepVoters = [10, 20, 30, 40, 50].map((power, i) => ({
      userId: `voter-drep-${i + 1}`,
      voterGroup: "drep",
      votingPower: power,
    }));
    const poolVoters = [1, 2, 3, 4, 5].map((power, i) => ({
      userId: `voter-pool-${i + 1}`,
      voterGroup: "pool",
      votingPower: power,
    }));
    await VoterCache.insertMany(makeVoterCaches(ballot._id, [...drepVoters, ...poolVoters]));

    const votes = [
      { userId: "voter-drep-1", submittedVote: ["abstain"], vote: ["abstain"] },
      { userId: "voter-drep-2", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-3", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-4", submittedVote: [2], vote: [2] },
      { userId: "voter-drep-5", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-1", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-2", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-3", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-4", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-5", submittedVote: [2], vote: [2] },
    ].map((v) => ({
      ballotId: ballot._id,
      proposalId: proposal._id,
      ...v,
      submittedAt: new Date(),
    }));
    await Vote.insertMany(votes);

    await aggregateVotes();

    const result = await Result.findOne({ proposalId: proposal._id }).lean();
    expect(result).not.toBeNull();
    const abstain = result.results.find((r) => r.id === "abstain");
    expect(abstain).toBeDefined();
    expect(abstain.count).toBe(1);
    expect(abstain.votingPower).toBe(10);

    const drep = result.resultsByGroup.drep;
    expect(drep).toBeDefined();
    expect(drep.totalVotes).toBe(5);
    const drepAbstain = drep.results.find((r) => r.id === "abstain");
    expect(drepAbstain).toEqual({ id: "abstain", label: "Abstain", count: 1, votingPower: 10 });

    const pool = result.resultsByGroup.pool;
    expect(pool).toBeDefined();
    expect(pool.totalVotes).toBe(5);
    const poolAbstain = pool.results.find((r) => r.id === "abstain");
    expect(poolAbstain).toBeDefined();
    expect(poolAbstain.count).toBe(0);
    expect(poolAbstain.votingPower).toBe(0);
  });

  test("default group: voter with no group appears in default group", async () => {
    const ballot = await Ballot.create(makeBallot(BALLOT_TITLE_PREFIX + runId + " default"));
    const proposal = await Proposal.create(makeProposal(ballot._id, { abstainAllowed: false }));

    const drepVoters = [10, 20, 30, 40, 50].map((power, i) => ({
      userId: `voter-drep-${i + 1}`,
      voterGroup: "drep",
      votingPower: power,
    }));
    const poolVoters = [1, 2, 3, 4, 5].map((power, i) => ({
      userId: `voter-pool-${i + 1}`,
      voterGroup: "pool",
      votingPower: power,
    }));
    const defaultVoter = { userId: "voter-default-1", voterGroup: "default", votingPower: 7 };
    await VoterCache.insertMany(makeVoterCaches(ballot._id, [...drepVoters, ...poolVoters, defaultVoter]));

    const votes = [
      { userId: "voter-drep-1", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-2", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-3", submittedVote: [1], vote: [1] },
      { userId: "voter-drep-4", submittedVote: [2], vote: [2] },
      { userId: "voter-drep-5", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-1", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-2", submittedVote: [1], vote: [1] },
      { userId: "voter-pool-3", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-4", submittedVote: [2], vote: [2] },
      { userId: "voter-pool-5", submittedVote: [2], vote: [2] },
      { userId: "voter-default-1", submittedVote: [1], vote: [1] },
    ].map((v) => ({
      ballotId: ballot._id,
      proposalId: proposal._id,
      ...v,
      submittedAt: new Date(),
    }));
    await Vote.insertMany(votes);

    await aggregateVotes();

    const result = await Result.findOne({ proposalId: proposal._id }).lean();
    expect(result).not.toBeNull();
    const yes = result.results.find((r) => r.id === 1);
    const no = result.results.find((r) => r.id === 2);
    expect(yes.count).toBe(6);
    expect(yes.votingPower).toBe(70);
    expect(no.count).toBe(5);
    expect(no.votingPower).toBe(102);

    expect(result.resultsByGroup.default).toBeDefined();
    const defaultGroup = result.resultsByGroup.default;
    expect(defaultGroup.totalVotes).toBe(1);
    expect(defaultGroup.results.find((r) => r.id === 1)).toEqual({ id: 1, label: "Yes", count: 1, votingPower: 7 });

    const drep = result.resultsByGroup.drep;
    expect(drep.results.find((r) => r.id === 1)).toEqual({ id: 1, label: "Yes", count: 3, votingPower: 60 });
    expect(drep.results.find((r) => r.id === 2)).toEqual({ id: 2, label: "No", count: 2, votingPower: 90 });
    const pool = result.resultsByGroup.pool;
    expect(pool.results.find((r) => r.id === 1)).toEqual({ id: 1, label: "Yes", count: 2, votingPower: 3 });
    expect(pool.results.find((r) => r.id === 2)).toEqual({ id: 2, label: "No", count: 3, votingPower: 12 });
  });
});
