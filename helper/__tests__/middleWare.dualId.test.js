// Verifies that helper/middleWare.js#getBallot and #getProposal pass
// the path-param through the resolver and surface the right `req`
// fields so route handlers can render `canonical` headers/body.
//
// The resolver is mocked via `jest.unstable_mockModule` so this test
// stays a pure unit (no Mongo, no model load order pitfalls).

import { jest } from "@jest/globals";

const mocks = {
  resolveBallot: jest.fn(),
  resolveProposal: jest.fn(),
};

await jest.unstable_mockModule("../idResolver.js", () => ({
  resolveBallot: (...args) => mocks.resolveBallot(...args),
  resolveProposal: (...args) => mocks.resolveProposal(...args),
}));

// Mongoose / schema imports inside middleWare.js carry side-effects;
// stub them out to keep this test fully isolated.
await jest.unstable_mockModule("../../schema/Ballot.js", () => ({ Ballot: {} }));
await jest.unstable_mockModule("../../schema/Proposal.js", () => ({ Proposal: {} }));
await jest.unstable_mockModule("../../schema/Transaction.js", () => ({ Transaction: {} }));
await jest.unstable_mockModule("../verifyToken.js", () => ({ verifyToken: () => ({}) }));
await jest.unstable_mockModule("../validateAddress.js", () => ({ validateAddress: () => ({}) }));
await jest.unstable_mockModule(
  "@emurgo/cardano-serialization-lib-nodejs",
  () => ({ PublicKey: {} })
);

const { getBallot, getProposal } = await import("../middleWare.js");

function mkRes() {
  const res = {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mocks.resolveBallot.mockReset();
  mocks.resolveProposal.mockReset();
});

// ---------------------------------------------------------------------------
// getBallot
// ---------------------------------------------------------------------------

describe("getBallot", () => {
  test("rejects missing / oversized ballotId with 400", async () => {
    const res1 = mkRes();
    await getBallot({ params: { ballotId: "" } }, res1, () => {
      throw new Error("next() should not run");
    });
    expect(res1.statusCode).toBe(400);

    const res2 = mkRes();
    await getBallot({ params: { ballotId: "x".repeat(129) } }, res2, () => {
      throw new Error("next() should not run");
    });
    expect(res2.statusCode).toBe(400);
  });

  test("404 when the resolver returns null", async () => {
    mocks.resolveBallot.mockResolvedValue(null);
    const res = mkRes();
    await getBallot({ params: { ballotId: "ghost" } }, res, () => {
      throw new Error("next() should not run");
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ status: "error" });
  });

  test("409 ID_COLLISION when the resolver returns ambiguous", async () => {
    mocks.resolveBallot.mockResolvedValue({
      ambiguous: ["a".repeat(24), "b".repeat(24)],
    });
    const res = mkRes();
    await getBallot({ params: { ballotId: "shared" } }, res, () => {
      throw new Error("next() should not run");
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("ID_COLLISION");
    expect(res.body.candidates).toHaveLength(2);
  });

  test("calls next() and attaches resolved fields on success", async () => {
    const id = "507f1f77bcf86cd799439011";
    const doc = {
      _id: id,
      toObject() {
        return { _id: id, title: "ok" };
      },
    };
    mocks.resolveBallot.mockResolvedValue({ doc, source: "external" });
    const req = { params: { ballotId: "upstream-1" } };
    const res = mkRes();
    let nextCalled = false;
    await getBallot(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(req.ballot).toBe(doc);
    expect(req.ballotId).toBe(id);
    expect(req.ballotResolvedFrom).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// getProposal
// ---------------------------------------------------------------------------

describe("getProposal", () => {
  test("404 when the resolver returns null", async () => {
    mocks.resolveProposal.mockResolvedValue(null);
    const res = mkRes();
    await getProposal({ params: { proposalId: "ghost" } }, res, () => {
      throw new Error("next() should not run");
    });
    expect(res.statusCode).toBe(404);
  });

  test("409 on ambiguous external proposal id", async () => {
    mocks.resolveProposal.mockResolvedValue({
      ambiguous: ["a".repeat(24), "b".repeat(24)],
    });
    const res = mkRes();
    await getProposal({ params: { proposalId: "shared" } }, res, () => {
      throw new Error("next() should not run");
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("ID_COLLISION");
  });

  test("forwards ballotId scope to the resolver when present in params", async () => {
    const doc = {
      _id: "p-id",
      toObject() {
        return { _id: "p-id" };
      },
    };
    mocks.resolveProposal.mockResolvedValue({ doc, source: "internal" });
    const req = { params: { proposalId: "x", ballotId: "b-id" } };
    const res = mkRes();
    await getProposal(req, res, () => {});
    expect(mocks.resolveProposal).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ ballotId: "b-id" })
    );
    expect(req.proposalResolvedFrom).toBe("internal");
  });
});
