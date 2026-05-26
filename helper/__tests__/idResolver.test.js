// Unit tests for helper/idResolver.js — covers internal-only,
// external-only, mixed, parent-scoped, ambiguous, invalid, and
// not-found paths via the `_internals._resolveByKey` seam (no Mongo).

import { jest } from "@jest/globals";
import mongoose from "mongoose";
import {
  _internals,
  canonicalSpaPath,
  canonicalApiPath,
  setCanonicalLinkHeader,
} from "../idResolver.js";

const { _resolveByKey, normalizeInput } = _internals;

// ----- Mock model helper ----------------------------------------------------
//
// `_resolveByKey` calls `Model.find(filter, projection, options).limit(2)`
// and awaits the limit() result. The simplest faithful stub is a `find`
// that records its args and returns an object with a `limit()` resolving
// to a fixed result. Each test builds a fresh model so call inspection
// is per-test.
function mockModel(docs, { findSpy } = {}) {
  return {
    find: jest.fn((filter, projection, options) => {
      if (findSpy) findSpy({ filter, projection, options });
      return {
        limit: jest.fn(() => Promise.resolve(docs)),
      };
    }),
  };
}

function oid() {
  return new mongoose.Types.ObjectId();
}

// ----- normalizeInput -------------------------------------------------------

describe("normalizeInput", () => {
  test("trims strings and rejects empty / null / oversized", () => {
    expect(normalizeInput("  hello  ")).toBe("hello");
    expect(normalizeInput("")).toBeNull();
    expect(normalizeInput("   ")).toBeNull();
    expect(normalizeInput(null)).toBeNull();
    expect(normalizeInput(undefined)).toBeNull();
    expect(normalizeInput("x".repeat(129))).toBeNull();
    expect(normalizeInput("x".repeat(128))).toBe("x".repeat(128));
  });

  test("coerces ObjectId-like inputs to string", () => {
    const o = oid();
    expect(normalizeInput(o)).toBe(String(o));
  });
});

// ----- _resolveByKey --------------------------------------------------------

describe("_resolveByKey", () => {
  const EXTERNAL_KEY = "external.id";

  test("returns null for empty / oversized input", async () => {
    const model = mockModel([]);
    expect(await _resolveByKey(model, EXTERNAL_KEY, null)).toBeNull();
    expect(await _resolveByKey(model, EXTERNAL_KEY, "")).toBeNull();
    expect(model.find).not.toHaveBeenCalled();
  });

  test("returns null when there are zero matches", async () => {
    const model = mockModel([]);
    const got = await _resolveByKey(model, EXTERNAL_KEY, "upstream-x");
    expect(got).toBeNull();
  });

  test("internal-only: 24-hex input that matches an _id is sourced as internal", async () => {
    const id = oid();
    const doc = { _id: id, label: "internal hit" };
    const findSpy = jest.fn();
    const model = mockModel([doc], { findSpy });

    const got = await _resolveByKey(model, EXTERNAL_KEY, String(id));

    expect(got).toEqual({ doc, source: "internal" });
    // Query was built with both clauses (ObjectId clause + external clause).
    expect(findSpy).toHaveBeenCalledTimes(1);
    const filter = findSpy.mock.calls[0][0].filter;
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toMatchObject({ _id: expect.anything() });
    expect(filter.$or[1]).toMatchObject({ [EXTERNAL_KEY]: String(id) });
  });

  test("external-only: non-hex input only emits the external clause", async () => {
    const doc = { _id: oid(), label: "external hit" };
    const findSpy = jest.fn();
    const model = mockModel([doc], { findSpy });

    const got = await _resolveByKey(model, EXTERNAL_KEY, "upstream-abc");
    expect(got).toEqual({ doc, source: "external" });

    const filter = findSpy.mock.calls[0][0].filter;
    expect(filter.$or).toHaveLength(1);
    expect(filter.$or[0]).toMatchObject({ [EXTERNAL_KEY]: "upstream-abc" });
  });

  test("24-hex input that only matches an external row is sourced as external", async () => {
    // The doc's _id is a different ObjectId; the row hit via external key.
    const input = String(oid());
    const doc = { _id: oid(), label: "external by 24-hex" };
    const model = mockModel([doc]);

    const got = await _resolveByKey(model, EXTERNAL_KEY, input);
    expect(got).toEqual({ doc, source: "external" });
  });

  test("collision: _id match + different doc external match → prefer _id", async () => {
    const id = oid();
    const internalDoc = { _id: id, label: "canonical" };
    const externalDoc = { _id: oid(), label: "shadows the canonical" };
    const model = mockModel([externalDoc, internalDoc]);

    const got = await _resolveByKey(model, EXTERNAL_KEY, String(id));
    expect(got).toEqual({ doc: internalDoc, source: "internal" });
  });

  test("ambiguous: 2 external matches with no _id tiebreaker → { ambiguous }", async () => {
    const a = { _id: oid() };
    const b = { _id: oid() };
    const model = mockModel([a, b]);

    const got = await _resolveByKey(model, EXTERNAL_KEY, "shared-upstream-id");
    expect(got).toEqual({ ambiguous: [String(a._id), String(b._id)] });
  });

  test("applies opts.scope to the filter and forwards projection + lean", async () => {
    const ballotId = oid();
    const doc = { _id: oid(), ballotId };
    const findSpy = jest.fn();
    const model = mockModel([doc], { findSpy });

    await _resolveByKey(model, EXTERNAL_KEY, "upstream-1", {
      scope: { ballotId },
      selectFields: { _id: 1, ballotId: 1 },
      lean: false,
    });

    const { filter, projection, options } = findSpy.mock.calls[0][0];
    expect(filter.ballotId).toEqual(ballotId);
    expect(filter.$or).toHaveLength(1); // not a valid ObjectId → external only
    expect(projection).toEqual({ _id: 1, ballotId: 1 });
    expect(options).toEqual({ lean: false });
  });
});

// ----- canonicalSpaPath / canonicalApiPath / header --------------------------

describe("canonicalSpaPath", () => {
  const b = { _id: oid() };
  const p = { _id: oid() };

  test("returns null without a ballot", () => {
    expect(canonicalSpaPath({})).toBeNull();
    expect(canonicalSpaPath()).toBeNull();
  });

  test("ballot-only path", () => {
    expect(canonicalSpaPath({ ballot: b })).toBe(`/ballots/${b._id}`);
  });

  test("ballot + proposal path", () => {
    expect(canonicalSpaPath({ ballot: b, proposal: p })).toBe(
      `/ballots/${b._id}/proposals/${p._id}`
    );
  });

  test("results view appended when flagged", () => {
    expect(
      canonicalSpaPath({ ballot: b, proposal: p, resultsView: true })
    ).toBe(`/ballots/${b._id}/proposals/${p._id}/results`);
  });
});

describe("canonicalApiPath", () => {
  const id = String(oid());

  test("ballot family", () => {
    expect(canonicalApiPath("ballot", id)).toBe(`/api/v1/ballots/${id}`);
    expect(canonicalApiPath("ballot-archive", id)).toBe(
      `/api/v1/ballots/${id}/archive`
    );
    expect(canonicalApiPath("ballot-certified", id)).toBe(
      `/api/v1/ballots/${id}/certified`
    );
  });

  test("ballot-question requires qid", () => {
    expect(canonicalApiPath("ballot-question", id)).toBeNull();
    expect(canonicalApiPath("ballot-question", id, { qid: "qq" })).toBe(
      `/api/v1/ballots/${id}/questions/qq/content`
    );
  });

  test("proposal family", () => {
    expect(canonicalApiPath("proposal", id)).toBe(
      `/api/v1/proposals/${id}`
    );
    expect(canonicalApiPath("proposals-by-ballot", id)).toBe(
      `/api/v1/proposals/ballot/${id}`
    );
  });

  test("unknown kind / missing id → null", () => {
    expect(canonicalApiPath("nope", id)).toBeNull();
    expect(canonicalApiPath("ballot", null)).toBeNull();
  });
});

describe("setCanonicalLinkHeader", () => {
  test("sets Link rel=canonical when url is present", () => {
    const set = jest.fn();
    const res = { set };
    setCanonicalLinkHeader(res, "/ballots/abc");
    expect(set).toHaveBeenCalledWith("Link", '</ballots/abc>; rel="canonical"');
  });

  test("no-op when url is falsy", () => {
    const set = jest.fn();
    setCanonicalLinkHeader({ set }, null);
    setCanonicalLinkHeader({ set }, undefined);
    setCanonicalLinkHeader({ set }, "");
    expect(set).not.toHaveBeenCalled();
  });
});
