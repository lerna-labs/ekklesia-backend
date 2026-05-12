// Stakeholder validator unit tests. Mocks helper/cardanoApi so the
// validator's own branch logic is exercised without network.
//
// Runs against the existing Mongo test DB (same pattern as
// aggregateVotes.grouped / votePackageLifecycle). Skips when no URI.

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

// Mock the API layer before importing the validator.
const mockAccountInfo = jest.fn();
const mockAccountAssets = jest.fn();
const mockAccountUtxos = jest.fn();
jest.unstable_mockModule("../helper/cardanoApi.js", () => ({
  accountInfo: mockAccountInfo,
  accountAssets: mockAccountAssets,
  accountUtxos: mockAccountUtxos,
  CardanoApiError: class extends Error {},
}));

const { validateVoter } = await import("../config/voterValidationStakeholder.js");
const mongoose = (await import("mongoose")).default;
const { Ballot } = await import("../schema/Ballot.js");
const { UserCache } = await import("../schema/UserCache.js");

const mongoUri = getMongoUri();
const runId = Date.now();
const STAKE_ADDR = `stake_test1_lifecycle_${runId}`;

let mongoReady = false;

const runDescribe = mongoUri ? describe : describe.skip;
runDescribe("voterValidationStakeholder (mongo)", () => {
  beforeAll(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
      mongoReady = true;
    } catch (err) {
      console.warn(
        `[voterValidationStakeholder] skipping: Mongo unreachable (${err.message}).`
      );
    }
  }, 10_000);

  afterAll(async () => {
    if (!mongoReady) return;
    try {
      await Ballot.deleteMany({ title: new RegExp(`^stake-test-${runId}`) });
      await UserCache.deleteMany({ userId: STAKE_ADDR });
    } finally {
      await mongoose.disconnect();
    }
  });

  beforeEach(() => {
    mockAccountInfo.mockReset();
    mockAccountAssets.mockReset();
    mockAccountUtxos.mockReset();
  });

  async function createBallot(title, requirements = null) {
    return Ballot.create({
      title,
      description: "stake validator test",
      voterType: "any",
      voterDescription: "stake test",
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
      voterGroups: [
        { group: "stake", powerSource: "StakeBased", requirements },
      ],
    });
  }

  const maybe = (name, fn) =>
    test(name, async () => {
      if (!mongoReady) return;
      await fn();
    });

  maybe("accepts a registered stake account (mustExist default)", async () => {
    const b = await createBallot(`stake-test-${runId}-a`);
    mockAccountInfo.mockResolvedValue({
      status: "registered",
      delegatedPool: "pool1abc",
      totalBalance: "12345",
    });
    const ok = await validateVoter(STAKE_ADDR, b._id);
    expect(ok).toBe(true);
    const cache = await UserCache.findOne({ userId: STAKE_ADDR, ballotId: b._id });
    expect(cache.validated).toBe(true);
    expect(cache.votingPower).toBe(12345);
  });

  maybe("rejects unknown stake account when mustExist is true", async () => {
    const b = await createBallot(`stake-test-${runId}-b`);
    mockAccountInfo.mockResolvedValue(null);
    mockAccountUtxos.mockResolvedValue([]);
    const ok = await validateVoter(STAKE_ADDR, b._id);
    expect(ok).toBe(false);
  });

  maybe("accepts unknown account with non-empty UTxOs (byron-like)", async () => {
    const b = await createBallot(`stake-test-${runId}-c`);
    mockAccountInfo.mockResolvedValue(null);
    mockAccountUtxos.mockResolvedValue([{ tx_hash: "x" }]);
    const ok = await validateVoter(STAKE_ADDR, b._id);
    expect(ok).toBe(true);
  });

  maybe("enforces allowedPools allow-list", async () => {
    const b = await createBallot(`stake-test-${runId}-d`, {
      mustExist: true,
      allowedPools: ["pool1allowed"],
    });
    mockAccountInfo.mockResolvedValue({
      status: "registered",
      delegatedPool: "pool1other",
      totalBalance: "1",
    });
    const ok = await validateVoter(STAKE_ADDR, b._id);
    expect(ok).toBe(false);
  });

  maybe("enforces tokenHoldings threshold", async () => {
    const b = await createBallot(`stake-test-${runId}-e`, {
      tokenHoldings: [
        { policyId: "aa".repeat(28), assetName: "deadbeef", minQuantity: "100" },
      ],
    });
    mockAccountInfo.mockResolvedValue({
      status: "registered",
      delegatedPool: "pool1x",
      totalBalance: "1",
    });
    mockAccountAssets.mockResolvedValue([
      { policyId: "aa".repeat(28), assetName: "deadbeef", quantity: "50" },
    ]);
    const reject = await validateVoter(STAKE_ADDR, b._id);
    expect(reject).toBe(false);

    // Same account, same requirement, but enough quantity now — 8h
    // cache hit on `false` would prevent the re-check, so bypass the
    // cache by using a distinct ballot.
    const b2 = await createBallot(`stake-test-${runId}-e2`, {
      tokenHoldings: [
        { policyId: "aa".repeat(28), assetName: "deadbeef", minQuantity: "100" },
      ],
    });
    mockAccountInfo.mockResolvedValue({
      status: "registered",
      delegatedPool: "pool1x",
      totalBalance: "1",
    });
    mockAccountAssets.mockResolvedValue([
      { policyId: "aa".repeat(28), assetName: "deadbeef", quantity: "500" },
    ]);
    const accept = await validateVoter(STAKE_ADDR, b2._id);
    expect(accept).toBe(true);
  });

  maybe("tokenHoldings with absent assetName matches any asset under policy", async () => {
    const b = await createBallot(`stake-test-${runId}-f`, {
      tokenHoldings: [{ policyId: "bb".repeat(28), minQuantity: "10" }],
    });
    mockAccountInfo.mockResolvedValue({
      status: "registered",
      delegatedPool: "pool1x",
      totalBalance: "1",
    });
    mockAccountAssets.mockResolvedValue([
      { policyId: "bb".repeat(28), assetName: "asset-a", quantity: "3" },
      { policyId: "bb".repeat(28), assetName: "asset-b", quantity: "9" },
      { policyId: "cc".repeat(28), assetName: "asset-c", quantity: "1000" },
    ]);
    const ok = await validateVoter(STAKE_ADDR, b._id);
    expect(ok).toBe(true);
  });
});
