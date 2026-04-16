// CompiledBallot — the contract between a proposals module (push) or
// an admin upload and this backend's importer.
//
// This file is the human-readable descriptor. The runtime validator
// lives in ./validator.js and enforces everything documented here
// plus the cross-cutting rules (facet keys, CSV encoding, live-ballot
// freeze). OpenAPI mirrors this shape under
// components.schemas.CompiledBallot.
//
// Evolve the contract by bumping SCHEMA_VERSION and branching the
// validator — never silently change a v1 meaning.

export const SCHEMA_VERSION = "1";

export const MAX = Object.freeze({
  title: 200,
  description: 2000,
  summary: 2000,
  rationale: 10000,
  authorName: 120,
  authors: 20,
  label: 120,
  facets: 20,
  options: 100,
  proposals: 500,
  voteOptions: 50,
});

/**
 * Reference shape. Comments describe semantics; types are strings so
 * this file stays dep-free. The validator treats this as documentation
 * only — the rules live in ./validator.js.
 */
export const COMPILED_BALLOT_SHAPE = Object.freeze({
  schemaVersion: "string, must equal SCHEMA_VERSION",
  source: {
    moduleId: "string, e.g. catalyst-v2",
    moduleUrl: "string URL",
    externalBallotId: "string, stable id in the source system",
    version: "string, source's own version tag for this import",
  },
  ballot: {
    title: `string ≤ ${MAX.title}`,
    description: `string ≤ ${MAX.description}`,
    voterType: 'string, e.g. "stake" | "drep" | "pool"',
    voterDescription: "string",
    voteWeighted: "boolean",
    voteFilters: "boolean",
    votePeriodStart: "ISO8601 date-time",
    votePeriodEnd: "ISO8601 date-time",
    proposalPeriodStart: "ISO8601 date-time",
    proposalPeriodEnd: "ISO8601 date-time",
    voteAuthorityId: "string",
    voteAuthorityAddress: "string, cardano address",
    ipfsHash: "string | null",
    voterValidationScript: "string (optional; uses default if absent)",
    rollupScript: "string (optional; uses default if absent)",
    startupScript: "string (optional; uses default if absent)",
  },
  facets: [
    {
      key: "string, must be URL-safe ident ([a-zA-Z0-9_-])",
      label: `string ≤ ${MAX.label}`,
      type: '"enum" | "number" | "string" | "boolean" | "date"',
      multi: "boolean (meaningful only for type:enum)",
      options: 'string[] (required iff type:"enum"); no item may contain ","',
      unit: "string | null",
      sortable: "boolean (must be false if multi:true)",
      filterable: "boolean",
      defaultSort: '"asc" | "desc" | null; at most one facet per ballot',
    },
  ],
  proposals: [
    {
      externalProposal: {
        id: "string, stable id in source system",
        url: "string URL (canonical 'view full proposal')",
        snapshot: {
          title: `string ≤ ${MAX.title}`,
          summary: `string ≤ ${MAX.summary}`,
          rationale: `string ≤ ${MAX.rationale} (optional)`,
          authors: `string[] ≤ ${MAX.authors} (each ≤ ${MAX.authorName})`,
          version: "string",
          facets: {
            "<facetKey>":
              "string or number — CSV for multi:true enums; raw for number/boolean/date",
          },
        },
      },
      title: `string ≤ ${MAX.title}`,
      voteType: '"default" | "budget" | "ranked" | "scale" | "preference"',
      voteIncrement: "number",
      voterBudget: "number",
      abstainAllowed: "boolean",
      voteOptions: [
        { id: "number | string('abstain')", cost: "number", label: "string" },
      ],
      data: "object, arbitrary structured data (bounded by overall payload size)",
      ipfsHash: "string | null",
    },
  ],
});
