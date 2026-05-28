/**
 * VotePackage lifecycle: idempotent /draft plumbing, TTL sweep, and
 * nonce release. Requires MongoDB (same skip-when-unreachable pattern
 * as aggregateVotes.grouped.test.js).
 *
 * The critical invariant under test: Hydra enforces strict
 * `signedPayload.nonce === currentVersion + 1`, so any abandoned
 * reservation MUST release its nonce back to UserCache — otherwise
 * the voter's next real submission collides and Hydra rejects.
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
import { VotePackage } from "../schema/VotePackage.js";
import { UserCache } from "../schema/UserCache.js";
import * as nonceManager from "../helper/nonceManager.js";
import { buildDraft } from "../helper/voteBroker.js";
import { sweepStaleVotePackages } from "../crons/sweepVotePackages.js";

const mongoUri = getMongoUri();
const runId = Date.now();
const BALLOT_ID = new mongoose.Types.ObjectId();
const USER_ID = `drep1_lifecycle_${runId}`;
const OTHER_BALLOT_ID = new mongoose.Types.ObjectId();

let mongoReady = false;

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("VotePackage lifecycle (mongo)", () => {
  beforeAll(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
      mongoReady = true;
    } catch (err) {
      console.warn(
        `[votePackageLifecycle] skipping: MongoDB unreachable at ${mongoUri} (${err.message}).`
      );
    }
  }, 10_000);

  afterAll(async () => {
    if (!mongoReady) return;
    try {
      await VotePackage.deleteMany({ userId: USER_ID });
      await UserCache.deleteMany({ userId: USER_ID });
    } finally {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    if (!mongoReady) return;
    await VotePackage.deleteMany({ userId: USER_ID });
    await UserCache.deleteMany({ userId: USER_ID });
  });

  const maybe = (name, fn) =>
    test(name, async () => {
      if (!mongoReady) return;
      await fn();
    });

  // --------------------------------------------------------------
  // buildDraft nonce behavior
  // --------------------------------------------------------------

  maybe("buildDraft reserves a new nonce when reuseNonce absent", async () => {
    const before = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });
    const draft = await buildDraft({
      ballotId: BALLOT_ID.toString(),
      voterId: USER_ID,
      credentialHrp: "drep",
      votes: [{ questionId: "q1", selection: [1] }],
    });
    const after = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(draft.nonce).toBe((before ?? 0) + 1);
    expect(after).toBe(draft.nonce);
  });

  maybe("buildDraft with reuseNonce skips reserveNext", async () => {
    // Seed UserCache so the nonce is committed at 1.
    await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    const storedBefore = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });

    const draft = await buildDraft({
      ballotId: BALLOT_ID.toString(),
      voterId: USER_ID,
      credentialHrp: "drep",
      votes: [{ questionId: "q1", selection: [2] }],
      reuseNonce: storedBefore,
    });

    const storedAfter = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(draft.nonce).toBe(storedBefore);
    expect(storedAfter).toBe(storedBefore); // unchanged — no new reservation
  });

  // --------------------------------------------------------------
  // TTL sweep + nonce release
  // --------------------------------------------------------------

  maybe("sweep abandons stale package and releases the nonce", async () => {
    // Reserve a nonce the way /draft would.
    const nonce = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(nonce).toBe(1);

    const oldActivity = new Date(Date.now() - 61 * 60 * 1000); // 61 min old
    await VotePackage.create({
      ballotId: BALLOT_ID,
      userId: USER_ID,
      signingPayload: { ballotId: BALLOT_ID.toString(), nonce, votes: [] },
      nonce,
      status: "awaiting-signatures",
      lastActivityAt: oldActivity,
    });

    const { swept } = await sweepStaleVotePackages({ ttlMinutes: 60 });
    expect(swept).toBe(1);

    const pkg = await VotePackage.findOne({ userId: USER_ID });
    expect(pkg.status).toBe("abandoned");
    expect(pkg.failureReason).toMatch(/TTL sweep/);

    // Critical: the reserved nonce is rolled back so a fresh draft
    // reuses the same value (matching Hydra's expected next nonce).
    const stored = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(stored).toBe(0);
  });

  maybe("sweep leaves fresh packages alone", async () => {
    const nonce = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    await VotePackage.create({
      ballotId: BALLOT_ID,
      userId: USER_ID,
      signingPayload: { ballotId: BALLOT_ID.toString(), nonce, votes: [] },
      nonce,
      status: "awaiting-signatures",
      lastActivityAt: new Date(), // fresh
    });

    const { swept } = await sweepStaleVotePackages({ ttlMinutes: 60 });
    expect(swept).toBe(0);
    const pkg = await VotePackage.findOne({ userId: USER_ID });
    expect(pkg.status).toBe("awaiting-signatures");
    const stored = await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(stored).toBe(nonce);
  });

  maybe("sweep leaves terminal packages alone", async () => {
    const nonce = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    await VotePackage.create({
      ballotId: BALLOT_ID,
      userId: USER_ID,
      signingPayload: { ballotId: BALLOT_ID.toString(), nonce, votes: [] },
      nonce,
      status: "hydra-confirmed",
      lastActivityAt: new Date(Date.now() - 61 * 60 * 1000),
    });
    const { swept } = await sweepStaleVotePackages({ ttlMinutes: 60 });
    expect(swept).toBe(0);
    const pkg = await VotePackage.findOne({ userId: USER_ID });
    expect(pkg.status).toBe("hydra-confirmed");
  });

  // --------------------------------------------------------------
  // Integration: reserve → abandon → fresh draft reuses same nonce
  // --------------------------------------------------------------

  maybe("draft → abandon-via-sweep → fresh draft reuses the same nonce", async () => {
    // Simulate /draft call #1: reserve nonce, create package.
    const nonce1 = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(nonce1).toBe(1);
    await VotePackage.create({
      ballotId: BALLOT_ID,
      userId: USER_ID,
      signingPayload: { ballotId: BALLOT_ID.toString(), nonce: nonce1, votes: [] },
      nonce: nonce1,
      status: "awaiting-signatures",
      lastActivityAt: new Date(Date.now() - 61 * 60 * 1000),
    });

    // TTL sweep fires — package abandoned, nonce released.
    await sweepStaleVotePackages({ ttlMinutes: 60 });

    // Voter comes back and drafts fresh: the reservation now yields
    // the SAME value (1), matching what Hydra expects as the next
    // nonce (currentVersion + 1 = 0 + 1 = 1, assuming no prior
    // confirmed vote).
    const nonce2 = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(nonce2).toBe(nonce1);
  });

  // --------------------------------------------------------------
  // Floor: reserveNext recovers when UserCache is wiped after a
  // successful submission. This is the regression that produced the
  // production "draft returns 1, Hydra expects N+1" reports.
  // --------------------------------------------------------------

  maybe("reserveNext floors at max(confirmed package nonce) + 1 when UserCache is wiped", async () => {
    // Seed the history Hydra would see: three earlier votes, all
    // hydra-confirmed, top nonce = 3.
    for (const n of [1, 2, 3]) {
      await VotePackage.create({
        ballotId: BALLOT_ID,
        userId: USER_ID,
        signingPayload: { ballotId: BALLOT_ID.toString(), nonce: n, votes: [] },
        nonce: n,
        status: "hydra-confirmed",
        confirmedAt: new Date(),
        lastActivityAt: new Date(),
      });
    }
    // Simulate the operator action that introduced the bug — wipe the
    // UserCache row outright. Pre-fix reserveNext would now return 1.
    await UserCache.deleteMany({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID })).toBeNull();

    const reserved = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(reserved).toBe(4); // 3 + 1, not 1
    expect(await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID })).toBe(4);
  });

  maybe("reserveNext floor ignores non-confirmed packages", async () => {
    // A failed/abandoned package's nonce should NOT pull the floor up —
    // those reservations are explicitly rolled back by release.
    await VotePackage.create({
      ballotId: BALLOT_ID,
      userId: USER_ID,
      signingPayload: { ballotId: BALLOT_ID.toString(), nonce: 5, votes: [] },
      nonce: 5,
      status: "failed",
      lastActivityAt: new Date(),
    });
    await UserCache.deleteMany({ userId: USER_ID, ballotId: BALLOT_ID });

    const reserved = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    expect(reserved).toBe(1); // floor stays 0 because nothing confirmed
  });

  maybe("release scoped correctly across ballots (no cross-ballot bleed)", async () => {
    // Two ballots for the same voter; abandoning one must not move
    // the nonce on the other.
    const n1 = await nonceManager.reserveNext({ userId: USER_ID, ballotId: BALLOT_ID });
    const n2 = await nonceManager.reserveNext({ userId: USER_ID, ballotId: OTHER_BALLOT_ID });
    expect(n1).toBe(1);
    expect(n2).toBe(1);

    await nonceManager.release({
      userId: USER_ID,
      ballotId: BALLOT_ID,
      nonce: n1,
    });

    expect(await nonceManager.peekCurrent({ userId: USER_ID, ballotId: BALLOT_ID })).toBe(0);
    expect(await nonceManager.peekCurrent({ userId: USER_ID, ballotId: OTHER_BALLOT_ID })).toBe(n2);

    await UserCache.deleteMany({ userId: USER_ID, ballotId: OTHER_BALLOT_ID });
  });
});
