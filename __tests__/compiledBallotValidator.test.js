import { validateCompiledBallot } from "../helper/compiledBallot/validator.js";

function baseValid() {
  return {
    schemaVersion: "1",
    source: {
      moduleId: "catalyst-v2",
      moduleUrl: "https://catalyst.example/",
      externalBallotId: "fund-11",
      version: "2025-04-01",
    },
    ballot: {
      title: "Fund 11",
      description: "Annual treasury round",
      voterType: "drep",
      voterDescription: "Active DReps",
      voteWeighted: true,
      voteFilters: false,
      votePeriodStart: "2026-05-01T00:00:00Z",
      votePeriodEnd: "2026-05-14T23:59:59Z",
      proposalPeriodStart: "2026-03-01T00:00:00Z",
      proposalPeriodEnd: "2026-04-15T23:59:59Z",
      voteAuthorityId: "auth-1",
      voteAuthorityAddress: "addr_test1...",
    },
    facets: [
      {
        key: "category",
        label: "Category",
        type: "enum",
        multi: true,
        options: ["education", "infrastructure"],
        sortable: false,
        filterable: true,
      },
    ],
    proposals: [
      {
        title: "Libraries for everyone",
        voteType: "default",
        voteOptions: [
          { id: 1, cost: 1, label: "Yes" },
          { id: 2, cost: 1, label: "No" },
        ],
        externalProposal: {
          id: "prop-001",
          url: "https://catalyst.example/p/001",
          snapshot: {
            title: "Libraries for everyone",
            summary: "Build community libraries in LATAM.",
            authors: ["Alice"],
            version: "v3",
            facets: { category: "education" },
          },
        },
      },
    ],
  };
}

describe("compiledBallot.validateCompiledBallot", () => {
  test("accepts a minimal well-formed payload", () => {
    const r = validateCompiledBallot(baseValid());
    expect(r).toEqual({ ok: true, errors: [] });
  });

  test("rejects wrong schemaVersion", () => {
    const p = baseValid();
    p.schemaVersion = "2";
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === "schemaVersion")).toBe(true);
  });

  test("rejects proposal facet key not declared on ballot", () => {
    const p = baseValid();
    p.proposals[0].externalProposal.snapshot.facets = { bogus: "x" };
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /unknown facet/.test(e.message))).toBe(true);
  });

  test("rejects proposal facet value not in declared options", () => {
    const p = baseValid();
    p.proposals[0].externalProposal.snapshot.facets = { category: "healthcare" };
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
  });

  test("rejects votePeriodEnd ≤ start", () => {
    const p = baseValid();
    p.ballot.votePeriodEnd = p.ballot.votePeriodStart;
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === "ballot.votePeriodEnd")).toBe(true);
  });

  test("rejects empty proposals[]", () => {
    const p = baseValid();
    p.proposals = [];
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === "proposals")).toBe(true);
  });

  test("rejects oversize title", () => {
    const p = baseValid();
    p.ballot.title = "x".repeat(201);
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
  });

  test("propagates facet-def errors", () => {
    const p = baseValid();
    p.facets[0].options = ["a", "b,c"];
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /comma/.test(e.message))).toBe(true);
  });

  test("CSV multi value on multi enum is accepted", () => {
    const p = baseValid();
    p.proposals[0].externalProposal.snapshot.facets = {
      category: "education,infrastructure",
    };
    const r = validateCompiledBallot(p);
    expect(r.ok).toBe(true);
  });
});
