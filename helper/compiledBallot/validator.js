// Runtime validator for CompiledBallot v1. Hand-rolled so we don't
// take on a new runtime dep (ajv) for a single contract. Each error
// carries a dotted path so the API can surface field-level messages.

import { SCHEMA_VERSION, MAX } from "./schema.js";
import {
  validateFacets,
  validateProposalFacetValues,
} from "../facets/validate.js";

const VOTER_TYPES = new Set(["stake", "drep", "pool", "cc", "any"]);
const VOTE_TYPES = new Set([
  "default",
  "budget",
  "weighted",
  "ranked",
  "scale",
  "preference",
  "likert",
]);

function isNonEmptyString(v, max) {
  return typeof v === "string" && v.length > 0 && (max == null || v.length <= max);
}

function isIsoDate(v) {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function pushMissing(errors, path) {
  errors.push({ path, message: "required" });
}

function pushType(errors, path, expected) {
  errors.push({ path, message: `must be ${expected}` });
}

function validateSource(src, errors) {
  if (!src || typeof src !== "object") {
    errors.push({ path: "source", message: "required object" });
    return;
  }
  ["moduleId", "externalBallotId"].forEach((k) => {
    if (!isNonEmptyString(src[k])) pushMissing(errors, `source.${k}`);
  });
  if (src.moduleUrl != null && typeof src.moduleUrl !== "string") {
    pushType(errors, "source.moduleUrl", "string");
  }
  if (src.version != null && typeof src.version !== "string") {
    pushType(errors, "source.version", "string");
  }
}

function validateBallot(b, errors) {
  if (!b || typeof b !== "object") {
    errors.push({ path: "ballot", message: "required object" });
    return;
  }
  if (!isNonEmptyString(b.title, MAX.title)) {
    errors.push({ path: "ballot.title", message: `required, ≤ ${MAX.title}` });
  }
  if (!isNonEmptyString(b.description, MAX.description)) {
    errors.push({
      path: "ballot.description",
      message: `required, ≤ ${MAX.description}`,
    });
  }
  if (!isNonEmptyString(b.voterType) || !VOTER_TYPES.has(b.voterType)) {
    errors.push({
      path: "ballot.voterType",
      message: `must be one of ${[...VOTER_TYPES].join(", ")}`,
    });
  }
  if (!isNonEmptyString(b.voterDescription)) {
    pushMissing(errors, "ballot.voterDescription");
  }
  ["voteWeighted", "voteFilters"].forEach((k) => {
    if (typeof b[k] !== "boolean") pushType(errors, `ballot.${k}`, "boolean");
  });
  ["votePeriodStart", "votePeriodEnd", "proposalPeriodStart", "proposalPeriodEnd"].forEach(
    (k) => {
      if (!isIsoDate(b[k])) {
        errors.push({ path: `ballot.${k}`, message: "must be ISO8601 date-time" });
      }
    }
  );
  if (!isNonEmptyString(b.voteAuthorityId)) pushMissing(errors, "ballot.voteAuthorityId");
  if (!isNonEmptyString(b.voteAuthorityAddress))
    pushMissing(errors, "ballot.voteAuthorityAddress");

  // Period sanity
  const vs = Date.parse(b.votePeriodStart);
  const ve = Date.parse(b.votePeriodEnd);
  if (Number.isFinite(vs) && Number.isFinite(ve) && ve <= vs) {
    errors.push({
      path: "ballot.votePeriodEnd",
      message: "must be after votePeriodStart",
    });
  }
}

function validateSnapshot(snap, path, facetDefs, errors) {
  if (!snap || typeof snap !== "object") {
    errors.push({ path, message: "required object" });
    return;
  }
  if (!isNonEmptyString(snap.title, MAX.title)) {
    errors.push({ path: `${path}.title`, message: `required, ≤ ${MAX.title}` });
  }
  if (!isNonEmptyString(snap.summary, MAX.summary)) {
    errors.push({
      path: `${path}.summary`,
      message: `required, ≤ ${MAX.summary}`,
    });
  }
  if (snap.rationale != null) {
    if (typeof snap.rationale !== "string" || snap.rationale.length > MAX.rationale) {
      errors.push({
        path: `${path}.rationale`,
        message: `optional, ≤ ${MAX.rationale}`,
      });
    }
  }
  if (snap.authors != null) {
    if (!Array.isArray(snap.authors) || snap.authors.length > MAX.authors) {
      errors.push({
        path: `${path}.authors`,
        message: `optional array, ≤ ${MAX.authors} entries`,
      });
    } else {
      snap.authors.forEach((a, i) => {
        if (!isNonEmptyString(a, MAX.authorName)) {
          errors.push({
            path: `${path}.authors[${i}]`,
            message: `≤ ${MAX.authorName}`,
          });
        }
      });
    }
  }
  if (snap.version != null && typeof snap.version !== "string") {
    pushType(errors, `${path}.version`, "string");
  }
  if (snap.facets != null) {
    const r = validateProposalFacetValues(snap.facets, facetDefs, {
      path: `${path}.facets`,
    });
    errors.push(...r.errors);
  }
}

function validateProposal(p, i, facetDefs, errors) {
  const path = `proposals[${i}]`;
  if (!p || typeof p !== "object") {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (!isNonEmptyString(p.title, MAX.title)) {
    errors.push({ path: `${path}.title`, message: `required, ≤ ${MAX.title}` });
  }
  if (p.voteType != null && !VOTE_TYPES.has(p.voteType)) {
    errors.push({
      path: `${path}.voteType`,
      message: `must be one of ${[...VOTE_TYPES].join(", ")}`,
    });
  }
  if (!Array.isArray(p.voteOptions) || p.voteOptions.length === 0) {
    errors.push({ path: `${path}.voteOptions`, message: "required, non-empty array" });
  } else if (p.voteOptions.length > MAX.voteOptions) {
    errors.push({
      path: `${path}.voteOptions`,
      message: `too many options (max ${MAX.voteOptions})`,
    });
  }

  if (p.externalProposal != null) {
    const ep = p.externalProposal;
    const epPath = `${path}.externalProposal`;
    if (typeof ep !== "object" || !ep) {
      errors.push({ path: epPath, message: "must be an object" });
    } else {
      if (!isNonEmptyString(ep.id)) pushMissing(errors, `${epPath}.id`);
      if (ep.url != null && typeof ep.url !== "string") {
        pushType(errors, `${epPath}.url`, "string");
      }
      validateSnapshot(ep.snapshot, `${epPath}.snapshot`, facetDefs, errors);
    }
  }
}

/**
 * Top-level entry point. Returns { ok, errors[] }.
 * Does NOT touch the database. The writer is responsible for the
 * live-ballot freeze check after validation passes.
 */
export function validateCompiledBallot(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: [{ path: "", message: "payload must be an object" }] };
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      message: `must equal "${SCHEMA_VERSION}"`,
    });
  }
  validateSource(payload.source, errors);
  validateBallot(payload.ballot, errors);

  const facets = payload.facets || [];
  const facetRes = validateFacets(facets);
  errors.push(...facetRes.errors);

  const proposals = payload.proposals;
  if (!Array.isArray(proposals) || proposals.length === 0) {
    errors.push({ path: "proposals", message: "required, non-empty array" });
  } else {
    if (proposals.length > MAX.proposals) {
      errors.push({
        path: "proposals",
        message: `too many proposals (max ${MAX.proposals})`,
      });
    }
    // Only run proposal-level facet checks if facet defs are themselves
    // well-formed — otherwise we'd double-report noise.
    const safeFacets = facetRes.ok ? facets : [];
    proposals.forEach((p, i) => validateProposal(p, i, safeFacets, errors));
  }

  return { ok: errors.length === 0, errors };
}
