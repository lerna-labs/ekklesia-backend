/**
 * Regression test for the voter-detail endpoint (GET /api/v0/voters/:userId).
 *
 * Bug: the directory list (GET /voters) is built from the durable `votes`
 * collection, but the detail endpoint used to hard-gate on a `usercaches`
 * row existing. UserCache is only written by the Hydra/v1 validation path,
 * so voters on legacy v0 ballots — including the script-based DRep first
 * reported — appeared in the directory but 404'd on detail. The fix makes
 * "has at least one submitted, non-excluded vote" the existence criterion,
 * matching the directory, and treats voting power as optional enrichment.
 *
 * Requires MongoDB. Same connection resolution + skip behaviour as the
 * other integration suites. Mounts the real voters router on a throwaway
 * Express app and drives it over loopback with the built-in fetch.
 */

import path from "path";
import { fileURLToPath } from "url";
import http from "http";
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

import express from "express";
import mongoose from "mongoose";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Vote } from "../schema/Vote.js";
import { User } from "../schema/User.js";
import { UserCache } from "../schema/UserCache.js";
import votersRouter from "../routes/api/v0/voters.js";

// The exact script-based DRep (CIP129, prefix byte 23) from the bug report.
const SCRIPT_DREP_ID =
  "drep1ydpfkyjxzeqvalf6fgvj7lznrk8kcmfnvy9hyl6gr6ez6wgsjaelx";
// Valid CIP129 drep ids (correct bech32 checksum) that simply have no
// votes — needed so validateAddress resolves cleanly to the 404 path
// rather than a 400 "invalid address".
const NONEXISTENT_DREP_ID =
  "drep1y242424242424242424242424242424242424242424242sdg97tu";
const EXCLUDED_ONLY_DREP_ID =
  "drep1ywamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwcxuxrz2";

const BALLOT_TITLE = "Test voter-detail UserCache-optional";
const mongoUri = getMongoUri();

function makeBallot(title) {
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    title,
    description: "Regression ballot for voter-detail",
    voterType: "drep",
    voterDescription: "Test voters",
    voteWeighted: false,
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

function makeProposal(ballotId) {
  return {
    ballotId,
    title: "Test proposal",
    description: "Test",
    voteType: "choice",
    voteOptions: [
      { id: 1, cost: 1, label: "Yes" },
      { id: 2, cost: 1, label: "No" },
    ],
    requireAnswer: true,
  };
}

let mongoReady = false;
let server;
let baseUrl;

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("GET /voters/:userId — UserCache is optional", () => {
  let ballot;
  let proposal;

  beforeAll(async () => {
    if (!mongoUri) return;
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
      mongoReady = true;
    } catch (err) {
      console.warn(
        `[voterDetail.userCacheOptional] skipping: MongoDB unreachable at ${mongoUri} (${err.message}). ` +
          `Start a local Mongo or set MONGODB_URI_TEST to a reachable server.`
      );
      return;
    }

    // Seed: a voter with a submitted, non-excluded vote on a legacy-style
    // ballot, a User row carrying their resolved name, and deliberately NO
    // UserCache row — exactly the production shape that produced the 404.
    ballot = await Ballot.create(makeBallot(BALLOT_TITLE));
    proposal = await Proposal.create(makeProposal(ballot._id));
    await Vote.create({
      ballotId: ballot._id,
      proposalId: proposal._id,
      userId: SCRIPT_DREP_ID,
      submittedVote: [1],
      vote: [1],
      submittedAt: new Date(),
    });
    await User.create({ _id: SCRIPT_DREP_ID, name: "Test Script DRep" });
    // Sanity: no UserCache for this voter — the precondition under test.
    expect(await UserCache.countDocuments({ userId: SCRIPT_DREP_ID })).toBe(0);

    const app = express();
    app.use("/voters", votersRouter);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  }, 15_000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (!mongoReady) return;
    try {
      if (proposal) await Vote.deleteMany({ proposalId: proposal._id });
      if (ballot) {
        await UserCache.deleteMany({ ballotId: ballot._id });
        await Proposal.deleteMany({ ballotId: ballot._id });
        await Ballot.deleteMany({ _id: ballot._id });
      }
      await User.deleteOne({ _id: SCRIPT_DREP_ID });
    } finally {
      await mongoose.disconnect();
    }
  });

  const maybeTest = (name, fn) =>
    test(name, async () => {
      if (!mongoReady) return;
      await fn();
    });

  maybeTest(
    "returns 200 with voting history for a script DRep that has votes but no UserCache row",
    async () => {
      const res = await fetch(`${baseUrl}/voters/${SCRIPT_DREP_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe(SCRIPT_DREP_ID);
      expect(body.voterType).toBe("drep");
      expect(body.name).toBe("Test Script DRep");
      expect(body.ballotsVoted).toBe(1);
      expect(body.proposalsVoted).toBe(1);
      // No UserCache row -> voting power falls back to 0, voter still visible.
      expect(body.votes[0].votingPower).toBe(0);
      expect(body.votes[0].proposals[0].vote).toEqual(["Yes"]);
    }
  );

  maybeTest("still 404s for a voter that has cast no votes", async () => {
    const res = await fetch(`${baseUrl}/voters/${NONEXISTENT_DREP_ID}`);
    expect(res.status).toBe(404);
  });

  maybeTest("excluded-only votes do not resurrect a voter (404)", async () => {
    // Same voter id, but the only vote is operator-excluded — must stay
    // hidden from detail just as it is from the directory.
    const exBallot = await Ballot.create(
      makeBallot(BALLOT_TITLE + " excluded")
    );
    const exProposal = await Proposal.create(makeProposal(exBallot._id));
    const exVoter = EXCLUDED_ONLY_DREP_ID;
    await Vote.create({
      ballotId: exBallot._id,
      proposalId: exProposal._id,
      userId: exVoter,
      submittedVote: [1],
      vote: [1],
      submittedAt: new Date(),
      excludedAt: new Date(),
    });
    try {
      const res = await fetch(`${baseUrl}/voters/${exVoter}`);
      expect(res.status).toBe(404);
    } finally {
      await Vote.deleteMany({ proposalId: exProposal._id });
      await Proposal.deleteMany({ ballotId: exBallot._id });
      await Ballot.deleteMany({ _id: exBallot._id });
    }
  });
});
