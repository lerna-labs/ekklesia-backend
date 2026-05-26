// Unit tests for helper/spaCanonicalRedirect.js.
//
// The orchestration depends on resolveBallot / resolveProposal, which
// hit Mongo at runtime. We mock those via `jest.unstable_mockModule`
// (the ESM mock seam) so the middleware can be exercised without a
// live database.

import { jest } from "@jest/globals";

// Per-test mock registry — the mocked module reads from these so each
// test can set its own resolver fixtures.
const mocks = {
  resolveBallot: jest.fn(),
  resolveProposal: jest.fn(),
};

await jest.unstable_mockModule("../idResolver.js", () => ({
  resolveBallot: (...args) => mocks.resolveBallot(...args),
  resolveProposal: (...args) => mocks.resolveProposal(...args),
}));

const { spaCanonicalRedirect, _internals } = await import(
  "../spaCanonicalRedirect.js"
);
const { TtlLru, ballotCache, proposalCache } = _internals;

function mkReq({ ballotId, proposalId, originalUrl, path }) {
  return {
    params: { ballotId, ...(proposalId ? { proposalId } : {}) },
    path: path ?? originalUrl?.split("?")[0] ?? "/",
    originalUrl: originalUrl ?? path ?? "/",
  };
}
function mkRes() {
  const res = {
    statusCode: 200,
    headers: {},
    redirected: null,
    redirect(code, target) {
      this.statusCode = code;
      this.redirected = target;
    },
  };
  return res;
}

beforeEach(() => {
  mocks.resolveBallot.mockReset();
  mocks.resolveProposal.mockReset();
  // Wipe caches between tests so previous resolutions don't leak.
  ballotCache.map.clear();
  proposalCache.map.clear();
});

// ---------------------------------------------------------------------------
// TtlLru
// ---------------------------------------------------------------------------

describe("TtlLru", () => {
  test("set/get round-trips within the TTL window", () => {
    const c = new TtlLru(10, 60_000);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
  });

  test("expires entries past the TTL", () => {
    const c = new TtlLru(10, 50);
    c.set("a", 1);
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now + 51;
    try {
      expect(c.get("a")).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  test("evicts the oldest entry when over capacity", () => {
    const c = new TtlLru(2, 60_000);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // evicts "a"
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });

  test("get refreshes LRU recency so a touched key isn't evicted", () => {
    const c = new TtlLru(2, 60_000);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");        // touches a
    c.set("c", 3);     // evicts b (now oldest)
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// spaCanonicalRedirect — orchestration
// ---------------------------------------------------------------------------

describe("spaCanonicalRedirect", () => {
  test("no-ops when no :ballotId is present", async () => {
    const req = mkReq({});
    const res = mkRes();
    let nextCalled = false;
    await spaCanonicalRedirect(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.redirected).toBeNull();
    expect(mocks.resolveBallot).not.toHaveBeenCalled();
  });

  test("falls through unchanged when the ballot id is already canonical", async () => {
    const canonical = "507f1f77bcf86cd799439011";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: canonical },
      source: "internal",
    });
    const req = mkReq({
      ballotId: canonical,
      originalUrl: `/ballots/${canonical}`,
    });
    const res = mkRes();
    let next = false;
    await spaCanonicalRedirect(req, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(res.redirected).toBeNull();
  });

  test("301-redirects when the ballot was addressed by external id", async () => {
    const canonical = "507f1f77bcf86cd799439011";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: canonical },
      source: "external",
    });
    const req = mkReq({
      ballotId: "upstream-ext-1",
      originalUrl: "/ballots/upstream-ext-1",
    });
    const res = mkRes();
    await spaCanonicalRedirect(req, res, () => {
      throw new Error("next() should not be called on a redirect");
    });
    expect(res.statusCode).toBe(301);
    expect(res.redirected).toBe(`/ballots/${canonical}`);
  });

  test("preserves the query string on redirect", async () => {
    const canonical = "507f1f77bcf86cd799439011";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: canonical },
      source: "external",
    });
    const req = mkReq({
      ballotId: "upstream-ext-1",
      originalUrl: "/ballots/upstream-ext-1?utm_source=email",
      path: "/ballots/upstream-ext-1",
    });
    const res = mkRes();
    await spaCanonicalRedirect(req, res, () => {});
    expect(res.redirected).toBe(
      `/ballots/${canonical}?utm_source=email`
    );
  });

  test("301-redirects when only the proposal segment is external", async () => {
    const ballot = "507f1f77bcf86cd799439011";
    const proposal = "507f1f77bcf86cd799439022";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: ballot },
      source: "internal",
    });
    mocks.resolveProposal.mockResolvedValue({
      doc: { _id: proposal },
      source: "external",
    });
    const req = mkReq({
      ballotId: ballot,
      proposalId: "upstream-prop-1",
      originalUrl: `/ballots/${ballot}/proposals/upstream-prop-1`,
    });
    const res = mkRes();
    await spaCanonicalRedirect(req, res, () => {});
    expect(res.statusCode).toBe(301);
    expect(res.redirected).toBe(
      `/ballots/${ballot}/proposals/${proposal}`
    );
  });

  test("falls through (no redirect) when the ballot id doesn't resolve", async () => {
    mocks.resolveBallot.mockResolvedValue(null);
    const req = mkReq({
      ballotId: "ghost-id",
      originalUrl: "/ballots/ghost-id",
    });
    const res = mkRes();
    let next = false;
    await spaCanonicalRedirect(req, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(res.redirected).toBeNull();
  });

  test("falls through (no redirect) on ambiguous external id", async () => {
    mocks.resolveBallot.mockResolvedValue({
      ambiguous: ["a".repeat(24), "b".repeat(24)],
    });
    const req = mkReq({
      ballotId: "shared-external",
      originalUrl: "/ballots/shared-external",
    });
    const res = mkRes();
    let next = false;
    await spaCanonicalRedirect(req, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(res.redirected).toBeNull();
  });

  test("propagates the /results suffix on the canonical URL", async () => {
    const ballot = "507f1f77bcf86cd799439011";
    const proposal = "507f1f77bcf86cd799439022";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: ballot },
      source: "external",
    });
    mocks.resolveProposal.mockResolvedValue({
      doc: { _id: proposal },
      source: "external",
    });
    const req = mkReq({
      ballotId: "upstream-b",
      proposalId: "upstream-p",
      originalUrl: "/ballots/upstream-b/proposals/upstream-p/results",
    });
    const res = mkRes();
    await spaCanonicalRedirect(req, res, () => {});
    expect(res.statusCode).toBe(301);
    expect(res.redirected).toBe(
      `/ballots/${ballot}/proposals/${proposal}/results`
    );
  });

  test("never throws (or redirects) when the resolver rejects", async () => {
    mocks.resolveBallot.mockRejectedValue(new Error("db down"));
    const req = mkReq({
      ballotId: "upstream-x",
      originalUrl: "/ballots/upstream-x",
    });
    const res = mkRes();
    let next = false;
    await spaCanonicalRedirect(req, res, () => {
      next = true;
    });
    expect(next).toBe(true);
    expect(res.redirected).toBeNull();
  });

  test("memoizes resolutions so a second hit doesn't re-query", async () => {
    const canonical = "507f1f77bcf86cd799439011";
    mocks.resolveBallot.mockResolvedValue({
      doc: { _id: canonical },
      source: "external",
    });
    const req1 = mkReq({
      ballotId: "upstream-q",
      originalUrl: "/ballots/upstream-q",
    });
    const req2 = mkReq({
      ballotId: "upstream-q",
      originalUrl: "/ballots/upstream-q",
    });
    await spaCanonicalRedirect(req1, mkRes(), () => {});
    await spaCanonicalRedirect(req2, mkRes(), () => {});
    expect(mocks.resolveBallot).toHaveBeenCalledTimes(1);
  });
});
