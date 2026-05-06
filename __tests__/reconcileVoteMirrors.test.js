/**
 * Reconciler for hydra-confirmed VotePackages whose Vote-collection
 * mirror was interrupted between pkg.save() and the inline
 * syncVoteRecords call in submitPackage().
 *
 * Skips when MongoDB is unreachable (same pattern as
 * votePackageLifecycle.test.js).
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
import { VotePackage } from "../schema/VotePackage.js";
import { Vote } from "../schema/Vote.js";
import { reconcileVoteMirrors } from "../crons/reconcileVoteMirrors.js";

const mongoUri = getMongoUri();
const runId = Date.now();
const USER_A = `drep1_reconcile_a_${runId}`;
const USER_B = `drep1_reconcile_b_${runId}`;
const USER_C = `drep1_reconcile_c_${runId}`;

let mongoReady = false;
let ballotId;
let proposalIdA;
let proposalIdB;

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("reconcileVoteMirrors (mongo)", () => {
  beforeAll(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
      mongoReady = true;
    } catch (err) {
      console.warn(
        `[reconcileVoteMirrors] skipping: MongoDB unreachable at ${mongoUri} (${err.message}).`
      );
    }
    if (!mongoReady) return;

    const now = new Date();
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const ballot = await Ballot.create({
      title: `reconcile-test-${runId}`,
      description: "test",
      voterType: "test",
      voterDescription: "test",
      voteWeighted: false,
      voteFilters: false,
      votePeriodStart: now,
      votePeriodEnd: later,
      proposalPeriodStart: now,
      proposalPeriodEnd: later,
      voteAuthorityId: "test-authority",
      voteAuthorityAddress: "addr_test_authority",
      status: "live",
      source: "hydra",
    });
    ballotId = ballot._id;
    proposalIdA = new mongoose.Types.ObjectId();
    proposalIdB = new mongoose.Types.ObjectId();
  }, 10_000);

  afterAll(async () => {
    if (!mongoReady) return;
    try {
      await VotePackage.deleteMany({ userId: { $in: [USER_A, USER_B, USER_C] } });
      await Vote.deleteMany({ userId: { $in: [USER_A, USER_B, USER_C] } });
      if (ballotId) await Ballot.deleteOne({ _id: ballotId });
    } finally {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    if (!mongoReady) return;
    await VotePackage.deleteMany({ userId: { $in: [USER_A, USER_B, USER_C] } });
    await Vote.deleteMany({ userId: { $in: [USER_A, USER_B, USER_C] } });
  });

  function makePackage(userId) {
    return {
      ballotId,
      userId,
      signingPayload: {
        votes: [
          { questionId: proposalIdA.toString(), selection: [1] },
          { questionId: proposalIdB.toString(), selection: [2] },
        ],
      },
      voteHash: `hash-${userId}`,
      nonce: 1,
      hydraTxId: `tx-${userId}`,
      confirmedAt: new Date(),
      status: "hydra-confirmed",
    };
  }

  test("orphaned package: no Vote rows exist → mirror restores all", async () => {
    if (!mongoReady) return;
    await VotePackage.create(makePackage(USER_A));

    const result = await reconcileVoteMirrors();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.restored).toBeGreaterThanOrEqual(1);

    const votes = await Vote.find({ userId: USER_A, ballotId }).lean();
    expect(votes).toHaveLength(2);
    const proposalIds = votes.map((v) => v.proposalId.toString()).sort();
    expect(proposalIds).toEqual(
      [proposalIdA.toString(), proposalIdB.toString()].sort()
    );
    expect(votes.every((v) => v.status === "hydra-confirmed")).toBe(true);
    expect(votes.every((v) => v.hydraTxId === `tx-${USER_A}`)).toBe(true);
  });

  test("partially mirrored: one row exists → reconciler fills the gap", async () => {
    if (!mongoReady) return;
    await VotePackage.create(makePackage(USER_B));
    await Vote.create({
      userId: USER_B,
      ballotId,
      proposalId: proposalIdA,
      vote: [1],
      submittedVote: [1],
      submittedAt: new Date(),
      status: "hydra-confirmed",
      hydraTxId: `tx-${USER_B}`,
    });

    const result = await reconcileVoteMirrors();
    expect(result.restored).toBeGreaterThanOrEqual(1);

    const votes = await Vote.find({ userId: USER_B, ballotId }).lean();
    expect(votes).toHaveLength(2);
  });

  test("fully mirrored: no-op, restored count unchanged", async () => {
    if (!mongoReady) return;
    await VotePackage.create(makePackage(USER_C));
    await Vote.insertMany([
      {
        userId: USER_C,
        ballotId,
        proposalId: proposalIdA,
        vote: [1],
        submittedVote: [1],
        submittedAt: new Date(),
        status: "hydra-confirmed",
      },
      {
        userId: USER_C,
        ballotId,
        proposalId: proposalIdB,
        vote: [2],
        submittedVote: [2],
        submittedAt: new Date(),
        status: "hydra-confirmed",
      },
    ]);

    const before = await Vote.countDocuments({ userId: USER_C });
    const result = await reconcileVoteMirrors();
    const after = await Vote.countDocuments({ userId: USER_C });

    // The reconciler may scan others, but it must not have restored
    // anything for this fully-mirrored package.
    expect(after).toBe(before);
    // No additional Vote rows for USER_C beyond the two we seeded.
    expect(after).toBe(2);
  });
});
