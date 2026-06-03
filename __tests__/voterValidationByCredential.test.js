// Voter-group gate test for config/voterValidationByCredential.js.
//
// The dispatcher must (a) route each recognized HRP to its per-group
// validator AND (b) refuse voters whose HRP isn't covered by the
// ballot's declared `voterGroups`. The stake-against-[drep,pool]
// case is the security-critical regression guard — that's the
// shape of the bug that admitted a stake voter to the DRep-only
// budget ballot.
//
// Per-group validators are mocked via `jest.unstable_mockModule` so
// this test exercises the dispatcher logic in isolation, without
// Koios or per-group caching getting involved. A real Mongo `Ballot`
// row backs each case because the dispatcher reads `voterGroups`
// directly off the document.
//
// Skips when no Mongo URI is reachable, matching the
// `aggregateVotes.grouped` / `voterValidationStakeholder` pattern.

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

import { jest } from "@jest/globals";

// Stub each per-group validator before importing the dispatcher.
// The factories must export every symbol ByCredential pulls in,
// otherwise the dynamic import fails with `SyntaxError: requested
// module ... does not provide an export named ...`.
const mockValidateDRep = jest.fn();
const mockValidatePoolPledge = jest.fn();
const mockValidateStake = jest.fn();

jest.unstable_mockModule("../config/voterValidationDReps.js", () => ({
  validateVoter: mockValidateDRep,
  allowedVoterCount: jest.fn().mockResolvedValue(0),
  getTotalWeight: jest.fn().mockResolvedValue(0),
}));
jest.unstable_mockModule("../config/voterValidationPoolsPledge.js", () => ({
  validateVoter: mockValidatePoolPledge,
  allowedVoterCount: jest.fn().mockResolvedValue(0),
  getTotalWeight: jest.fn().mockResolvedValue(0),
}));
jest.unstable_mockModule("../config/voterValidationStakeholder.js", () => ({
  validateVoter: mockValidateStake,
  allowedVoterCount: jest.fn().mockResolvedValue(0),
  getTotalWeight: jest.fn().mockResolvedValue(0),
}));

const { validateVoter } = await import(
  "../config/voterValidationByCredential.js"
);
const mongoose = (await import("mongoose")).default;
const { Ballot } = await import("../schema/Ballot.js");

const mongoUri = getMongoUri();
const runId = Date.now();
let mongoReady = false;

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("voterValidationByCredential — voterGroups gate (mongo)", () => {
  beforeAll(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
      mongoReady = true;
    } catch (err) {
      console.warn(
        `[voterValidationByCredential] skipping: Mongo unreachable (${err.message}).`
      );
    }
  }, 10_000);

  afterAll(async () => {
    if (!mongoReady) return;
    try {
      await Ballot.deleteMany({ title: new RegExp(`^bycred-test-${runId}`) });
    } finally {
      await mongoose.disconnect();
    }
  });

  beforeEach(() => {
    mockValidateDRep.mockReset();
    mockValidatePoolPledge.mockReset();
    mockValidateStake.mockReset();
    // Default: per-group validators succeed if reached. Cases that need
    // to assert "validator was NOT reached" check the call count.
    mockValidateDRep.mockResolvedValue(true);
    mockValidatePoolPledge.mockResolvedValue(true);
    mockValidateStake.mockResolvedValue(true);
  });

  async function createBallot(suffix, voterGroups) {
    return Ballot.create({
      title: `bycred-test-${runId}-${suffix}`,
      description: "ByCredential gate test",
      voterType: "any",
      voterDescription: "test",
      voteWeighted: true,
      voteFilters: false,
      votePeriodStart: new Date(Date.now() - 60 * 1000),
      votePeriodEnd: new Date(Date.now() + 60 * 60 * 1000),
      proposalPeriodStart: new Date(),
      proposalPeriodEnd: new Date(),
      voteAuthorityId: "t",
      voteAuthorityAddress: "addr_test_t",
      status: "live",
      source: "hydra",
      voterValidationScript: "voterValidationByCredential.js",
      voterGroups,
    });
  }

  const maybe = (name, fn) =>
    test(name, async () => {
      if (!mongoReady) return;
      await fn();
    });

  // ───── Happy paths: HRP matches declared group ─────────────────────

  maybe("routes drep voter to validateDRep when drep is declared", async () => {
    const b = await createBallot("drep-ok", [
      { group: "drep", powerSource: "StakeBased" },
      { group: "pool", powerSource: "PledgeBased" },
    ]);
    const ok = await validateVoter(`drep1test_${runId}`, b._id);
    expect(ok).toBe(true);
    expect(mockValidateDRep).toHaveBeenCalledTimes(1);
    expect(mockValidatePoolPledge).not.toHaveBeenCalled();
    expect(mockValidateStake).not.toHaveBeenCalled();
  });

  maybe("routes pool voter to validatePoolPledge when pool is declared", async () => {
    const b = await createBallot("pool-ok", [
      { group: "drep", powerSource: "StakeBased" },
      { group: "pool", powerSource: "PledgeBased" },
    ]);
    const ok = await validateVoter(`pool1test_${runId}`, b._id);
    expect(ok).toBe(true);
    expect(mockValidatePoolPledge).toHaveBeenCalledTimes(1);
    expect(mockValidateDRep).not.toHaveBeenCalled();
    expect(mockValidateStake).not.toHaveBeenCalled();
  });

  maybe("treats calidus HRP as the pool group", async () => {
    const b = await createBallot("calidus-ok", [
      { group: "pool", powerSource: "PledgeBased" },
    ]);
    const ok = await validateVoter(`calidus1test_${runId}`, b._id);
    expect(ok).toBe(true);
    expect(mockValidatePoolPledge).toHaveBeenCalledTimes(1);
    expect(mockValidateStake).not.toHaveBeenCalled();
  });

  // ───── Regression guard: HRP not in declared groups ────────────────

  maybe(
    "REJECTS stake voter on a [drep, pool] ballot without calling validateStake",
    async () => {
      const b = await createBallot("stake-vs-drep-pool", [
        { group: "drep", powerSource: "StakeBased" },
        { group: "pool", powerSource: "PledgeBased" },
      ]);
      const ok = await validateVoter(`stake1test_${runId}`, b._id);
      expect(ok).toBe(false);
      // The whole point of the gate: stake validation must NEVER even
      // be attempted on a ballot that doesn't declare the stake group.
      expect(mockValidateStake).not.toHaveBeenCalled();
      expect(mockValidateDRep).not.toHaveBeenCalled();
      expect(mockValidatePoolPledge).not.toHaveBeenCalled();
    }
  );

  maybe("rejects drep voter on a stake-only ballot", async () => {
    const b = await createBallot("drep-vs-stake-only", [
      { group: "stake", powerSource: "StakeBased" },
    ]);
    const ok = await validateVoter(`drep1test_${runId}`, b._id);
    expect(ok).toBe(false);
    expect(mockValidateDRep).not.toHaveBeenCalled();
  });

  maybe("rejects pool voter on a drep-only ballot", async () => {
    const b = await createBallot("pool-vs-drep-only", [
      { group: "drep", powerSource: "StakeBased" },
    ]);
    const ok = await validateVoter(`pool1test_${runId}`, b._id);
    expect(ok).toBe(false);
    expect(mockValidatePoolPledge).not.toHaveBeenCalled();
  });

  // ───── Legacy / edge ────────────────────────────────────────────────

  maybe(
    "permissive when voterGroups is empty (legacy pre-declaration ballots)",
    async () => {
      const b = await createBallot("legacy-empty-groups", []);
      const ok = await validateVoter(`stake1test_${runId}`, b._id);
      expect(ok).toBe(true);
      // Empty voterGroups means the legacy dispatcher path runs as-is.
      expect(mockValidateStake).toHaveBeenCalledTimes(1);
    }
  );

  maybe("rejects unknown HRP regardless of voterGroups", async () => {
    const b = await createBallot("unknown-hrp", [
      { group: "drep", powerSource: "StakeBased" },
    ]);
    const ok = await validateVoter("totallybogusprefix1xyz", b._id);
    expect(ok).toBe(false);
    expect(mockValidateDRep).not.toHaveBeenCalled();
    expect(mockValidatePoolPledge).not.toHaveBeenCalled();
    expect(mockValidateStake).not.toHaveBeenCalled();
  });

  maybe("rejects when ballot is missing", async () => {
    const ghostId = new mongoose.Types.ObjectId();
    const ok = await validateVoter(`drep1test_${runId}`, ghostId);
    expect(ok).toBe(false);
    expect(mockValidateDRep).not.toHaveBeenCalled();
  });
});
