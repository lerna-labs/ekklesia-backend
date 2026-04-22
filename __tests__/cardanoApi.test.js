// Fallback semantics for the Koios→Blockfrost account-API layer.
// Mocks global.fetch so the tests run without network or credentials.

import { jest } from "@jest/globals";
import { accountInfo, accountAssets, CardanoApiError } from "../helper/cardanoApi.js";

// Capture-and-replay fetch mock. Each test builds a queue of
// (urlMatcher, responseFactory) and the mock pops whichever matches
// in order. Unexpected calls throw so we catch test misconfig fast.
let fetchQueue = [];
const realFetch = global.fetch;

beforeEach(() => {
  fetchQueue = [];
  global.fetch = jest.fn((url, init) => {
    const entry = fetchQueue.shift();
    if (!entry) {
      return Promise.reject(new Error(`Unmocked fetch: ${url}`));
    }
    const match = typeof entry.match === "function" ? entry.match(url, init) : true;
    if (!match) {
      return Promise.reject(new Error(`Mock mismatch at: ${url}`));
    }
    return Promise.resolve(entry.response(url, init));
  });
  // Guarantee env starts clean per test.
  process.env.API_URL = "https://preprod.koios.rest/api/v1";
  delete process.env.API_TOKEN;
  delete process.env.BLOCKFROST_PROJECT_ID;
  delete process.env.BLOCKFROST_URL;
});

afterAll(() => {
  global.fetch = realFetch;
});

function koiosOk(body) {
  return {
    match: (url) => String(url).includes("koios.rest"),
    response: () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}
function koios5xx(status = 503) {
  return {
    match: (url) => String(url).includes("koios.rest"),
    response: () =>
      new Response("upstream down", { status, statusText: "Service Unavailable" }),
  };
}
function koiosNetworkError() {
  return {
    match: (url) => String(url).includes("koios.rest"),
    response: () => Promise.reject(new TypeError("fetch failed")),
  };
}
function blockfrostOk(body) {
  return {
    match: (url) => String(url).includes("blockfrost.io"),
    response: () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

describe("cardanoApi — Koios primary, Blockfrost fallback", () => {
  test("happy path: Koios 200, fallback not invoked", async () => {
    fetchQueue.push(
      koiosOk([
        {
          stake_address: "stake_test1abc",
          status: "registered",
          delegated_pool: "pool1xyz",
          total_balance: "1000000",
          utxo: "1",
        },
      ])
    );
    const info = await accountInfo("stake_test1abc");
    expect(info.provider).toBe("koios");
    expect(info.delegatedPool).toBe("pool1xyz");
    expect(info.totalBalance).toBe("1000000");
  });

  test("falls back on Koios 503 when BLOCKFROST_PROJECT_ID set", async () => {
    process.env.BLOCKFROST_PROJECT_ID = "preprodtest123";
    fetchQueue.push(koios5xx(503));
    fetchQueue.push(
      blockfrostOk({
        active: true,
        pool_id: "pool1fallback",
        controlled_amount: "42",
        rewards_sum: "0",
      })
    );
    const info = await accountInfo("stake_test1abc");
    expect(info.provider).toBe("blockfrost");
    expect(info.delegatedPool).toBe("pool1fallback");
    expect(info.totalBalance).toBe("42");
  });

  test("falls back on Koios 429 rate-limit", async () => {
    process.env.BLOCKFROST_PROJECT_ID = "preprodtest123";
    fetchQueue.push(koios5xx(429));
    fetchQueue.push(blockfrostOk({ active: false, pool_id: null, controlled_amount: "0", rewards_sum: "0" }));
    const info = await accountInfo("stake_test1abc");
    expect(info.provider).toBe("blockfrost");
  });

  test("falls back on network error", async () => {
    process.env.BLOCKFROST_PROJECT_ID = "preprodtest123";
    fetchQueue.push(koiosNetworkError());
    fetchQueue.push(blockfrostOk({ active: true, pool_id: "pool1nw", controlled_amount: "1", rewards_sum: "0" }));
    const info = await accountInfo("stake_test1abc");
    expect(info.provider).toBe("blockfrost");
    expect(info.delegatedPool).toBe("pool1nw");
  });

  test("Koios 4xx (non-429) surfaces, fallback not invoked", async () => {
    process.env.BLOCKFROST_PROJECT_ID = "preprodtest123";
    fetchQueue.push({
      match: (url) => String(url).includes("koios.rest"),
      response: () => new Response("bad request", { status: 400 }),
    });
    // No blockfrost entry — if fallback fires, fetch throws on empty queue.
    await expect(accountInfo("stake_test1abc")).rejects.toBeInstanceOf(CardanoApiError);
  });

  test("no BLOCKFROST_PROJECT_ID → no fallback, Koios error surfaces", async () => {
    fetchQueue.push(koios5xx(502));
    await expect(accountInfo("stake_test1abc")).rejects.toMatchObject({
      status: 502,
      provider: "koios",
    });
  });

  test("accountAssets normalizes Blockfrost's concatenated unit field", async () => {
    process.env.BLOCKFROST_PROJECT_ID = "preprodtest123";
    fetchQueue.push(koios5xx(503));
    // Blockfrost `unit` = policyId (56 hex) + asset_name (hex)
    const policy = "a".repeat(56);
    const assetName = "deadbeef";
    fetchQueue.push(
      blockfrostOk([{ unit: policy + assetName, quantity: "5" }])
    );
    const assets = await accountAssets("stake_test1abc");
    expect(assets).toHaveLength(1);
    expect(assets[0].policyId).toBe(policy);
    expect(assets[0].assetName).toBe(assetName);
    expect(assets[0].quantity).toBe("5");
    expect(assets[0].provider).toBe("blockfrost");
  });

  test("Koios accountAssets keeps policy and asset_name separate", async () => {
    fetchQueue.push(
      koiosOk([
        {
          policy_id: "b".repeat(56),
          asset_name: "beef",
          fingerprint: "asset1xyz",
          quantity: "9",
        },
      ])
    );
    const assets = await accountAssets("stake_test1abc");
    expect(assets[0].provider).toBe("koios");
    expect(assets[0].policyId).toBe("b".repeat(56));
    expect(assets[0].assetName).toBe("beef");
  });
});
