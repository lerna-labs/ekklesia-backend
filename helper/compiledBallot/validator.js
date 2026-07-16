// Runtime validator for CompiledBallot v1. Hand-rolled so we don't
// take on a new runtime dep (ajv) for a single contract. Each error
// carries a dotted path so the API can surface field-level messages.

import { SCHEMA_VERSION, MAX } from './schema.js';
import { validateFacets, validateProposalFacetValues } from '../facets/validate.js';

const VOTER_TYPES = new Set(['stake', 'drep', 'pool', 'any']);

const VOTER_GROUPS = new Set(['drep', 'pool', 'stake']);
const POWER_SOURCES = new Set(['CredentialBased', 'StakeBased', 'PledgeBased']);
// Hydra's RoleWeighting type constrains which power sources are valid
// for each group. Enforced at /prepare too, but we pre-flight here for
// friendly authoring errors.
const VALID_POWER_SOURCES_BY_GROUP = {
  drep: new Set(['CredentialBased', 'StakeBased']),
  pool: new Set(['CredentialBased', 'StakeBased', 'PledgeBased']),
  stake: new Set(['StakeBased']),
};
const VOTE_TYPES = new Set([
  'choice',
  'multi-choice',
  'budget',
  'weighted',
  'ranked',
  'scale',
  'likert',
]);

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.length > 0 && (max == null || v.length <= max);
}

function isIsoDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function pushMissing(errors, path) {
  errors.push({ path, message: 'required' });
}

function pushType(errors, path, expected) {
  errors.push({ path, message: `must be ${expected}` });
}

function validateSource(src, errors) {
  if (!src || typeof src !== 'object') {
    errors.push({ path: 'source', message: 'required object' });
    return;
  }
  ['moduleId', 'externalBallotId'].forEach((k) => {
    if (!isNonEmptyString(src[k])) pushMissing(errors, `source.${k}`);
  });
  if (src.moduleUrl != null && typeof src.moduleUrl !== 'string') {
    pushType(errors, 'source.moduleUrl', 'string');
  }
  if (src.version != null && typeof src.version !== 'string') {
    pushType(errors, 'source.version', 'string');
  }
}

function validateVoterGroups(groups, errors) {
  // voterGroups is optional (omitted ballots fall back to voterType-
  // based inference in hydraPrepare). When present, each entry must
  // declare a valid group + a power-source that's admissible for that
  // group per Hydra's RoleWeighting type.
  if (groups == null) return;
  if (!Array.isArray(groups)) {
    errors.push({ path: 'ballot.voterGroups', message: 'must be an array when present' });
    return;
  }
  const seen = new Set();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const path = `ballot.voterGroups[${i}]`;
    if (!g || typeof g !== 'object') {
      errors.push({ path, message: 'must be an object' });
      continue;
    }
    if (!VOTER_GROUPS.has(g.group)) {
      errors.push({
        path: `${path}.group`,
        message: `must be one of ${[...VOTER_GROUPS].join(', ')}`,
      });
      continue;
    }
    if (seen.has(g.group)) {
      errors.push({ path: `${path}.group`, message: `duplicate group "${g.group}"` });
    }
    seen.add(g.group);
    if (!POWER_SOURCES.has(g.powerSource)) {
      errors.push({
        path: `${path}.powerSource`,
        message: `must be one of ${[...POWER_SOURCES].join(', ')}`,
      });
      continue;
    }
    const allowed = VALID_POWER_SOURCES_BY_GROUP[g.group];
    if (!allowed.has(g.powerSource)) {
      errors.push({
        path: `${path}.powerSource`,
        message: `not valid for group "${g.group}" (allowed: ${[...allowed].join(', ')})`,
      });
    }
  }
}

function validateBallot(b, errors) {
  if (!b || typeof b !== 'object') {
    errors.push({ path: 'ballot', message: 'required object' });
    return;
  }
  if (!isNonEmptyString(b.title, MAX.title)) {
    errors.push({ path: 'ballot.title', message: `required, ≤ ${MAX.title}` });
  }
  if (!isNonEmptyString(b.description, MAX.description)) {
    errors.push({
      path: 'ballot.description',
      message: `required, ≤ ${MAX.description}`,
    });
  }
  if (!isNonEmptyString(b.voterType) || !VOTER_TYPES.has(b.voterType)) {
    errors.push({
      path: 'ballot.voterType',
      message: `must be one of ${[...VOTER_TYPES].join(', ')}`,
    });
  }
  if (!isNonEmptyString(b.voterDescription)) {
    pushMissing(errors, 'ballot.voterDescription');
  }
  validateVoterGroups(b.voterGroups, errors);
  ['voteWeighted', 'voteFilters'].forEach((k) => {
    if (typeof b[k] !== 'boolean') pushType(errors, `ballot.${k}`, 'boolean');
  });
  ['votePeriodStart', 'votePeriodEnd', 'proposalPeriodStart', 'proposalPeriodEnd'].forEach((k) => {
    if (!isIsoDate(b[k])) {
      errors.push({ path: `ballot.${k}`, message: 'must be ISO8601 date-time' });
    }
  });
  if (!isNonEmptyString(b.voteAuthorityId)) pushMissing(errors, 'ballot.voteAuthorityId');
  if (!isNonEmptyString(b.voteAuthorityAddress)) pushMissing(errors, 'ballot.voteAuthorityAddress');

  // Period sanity
  const vs = Date.parse(b.votePeriodStart);
  const ve = Date.parse(b.votePeriodEnd);
  if (Number.isFinite(vs) && Number.isFinite(ve) && ve <= vs) {
    errors.push({
      path: 'ballot.votePeriodEnd',
      message: 'must be after votePeriodStart',
    });
  }
}

function validateSnapshot(snap, path, facetDefs, errors) {
  if (!snap || typeof snap !== 'object') {
    errors.push({ path, message: 'required object' });
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
    if (typeof snap.rationale !== 'string' || snap.rationale.length > MAX.rationale) {
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
  if (snap.version != null && typeof snap.version !== 'string') {
    pushType(errors, `${path}.version`, 'string');
  }
  if (snap.facets != null) {
    const r = validateProposalFacetValues(snap.facets, facetDefs, {
      path: `${path}.facets`,
    });
    errors.push(...r.errors);
  }
}

const VOTE_OPTION_MAX = Object.freeze({
  label: 120,
  description: 1000,
  url: 500,
});

function validateVoteOptions(options, path, errors) {
  const seenIds = new Set();
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const p = `${path}[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      errors.push({ path: p, message: 'must be an object' });
      continue;
    }
    // id — Number.isInteger OR the legacy "abstain" sentinel. Reject
    // anything else (strings that aren't "abstain", floats, etc.).
    const validId = Number.isInteger(o.id) || o.id === 'abstain';
    if (!validId) {
      errors.push({
        path: `${p}.id`,
        message: 'must be an integer (or the legacy "abstain" sentinel)',
      });
    } else if (seenIds.has(o.id)) {
      errors.push({ path: `${p}.id`, message: `duplicate option id ${JSON.stringify(o.id)}` });
    }
    seenIds.add(o.id);
    if (!isNonEmptyString(o.label, VOTE_OPTION_MAX.label)) {
      errors.push({
        path: `${p}.label`,
        message: `required, ≤ ${VOTE_OPTION_MAX.label}`,
      });
    }
    if (o.cost != null) {
      if (typeof o.cost !== 'number' || !Number.isFinite(o.cost) || o.cost < 0) {
        errors.push({ path: `${p}.cost`, message: 'must be a non-negative number' });
      }
    }
    if (o.description != null) {
      if (typeof o.description !== 'string' || o.description.length > VOTE_OPTION_MAX.description) {
        errors.push({
          path: `${p}.description`,
          message: `optional string, ≤ ${VOTE_OPTION_MAX.description}`,
        });
      }
    }
    if (o.referenceUrl != null) {
      if (typeof o.referenceUrl !== 'string' || o.referenceUrl.length > VOTE_OPTION_MAX.url) {
        errors.push({
          path: `${p}.referenceUrl`,
          message: `optional string, ≤ ${VOTE_OPTION_MAX.url}`,
        });
      }
    }
    if (o.imageUrl != null) {
      if (typeof o.imageUrl !== 'string' || o.imageUrl.length > VOTE_OPTION_MAX.url) {
        errors.push({
          path: `${p}.imageUrl`,
          message: `optional string, ≤ ${VOTE_OPTION_MAX.url}`,
        });
      }
    }
    if (o.metadata != null && (typeof o.metadata !== 'object' || Array.isArray(o.metadata))) {
      errors.push({ path: `${p}.metadata`, message: 'optional object (free-form)' });
    }
  }
}

function validateProposal(p, i, facetDefs, errors) {
  const path = `proposals[${i}]`;
  if (!p || typeof p !== 'object') {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  if (!isNonEmptyString(p.title, MAX.title)) {
    errors.push({ path: `${path}.title`, message: `required, ≤ ${MAX.title}` });
  }
  if (p.voteType != null && !VOTE_TYPES.has(p.voteType)) {
    errors.push({
      path: `${path}.voteType`,
      message: `must be one of ${[...VOTE_TYPES].join(', ')}`,
    });
  }
  if (!Array.isArray(p.voteOptions) || p.voteOptions.length === 0) {
    errors.push({ path: `${path}.voteOptions`, message: 'required, non-empty array' });
  } else if (p.voteOptions.length > MAX.voteOptions) {
    errors.push({
      path: `${path}.voteOptions`,
      message: `too many options (max ${MAX.voteOptions})`,
    });
  } else {
    validateVoteOptions(p.voteOptions, `${path}.voteOptions`, errors);
  }

  if (p.externalProposal != null) {
    const ep = p.externalProposal;
    const epPath = `${path}.externalProposal`;
    if (typeof ep !== 'object' || !ep) {
      errors.push({ path: epPath, message: 'must be an object' });
    } else {
      if (!isNonEmptyString(ep.id)) pushMissing(errors, `${epPath}.id`);
      if (ep.url != null && typeof ep.url !== 'string') {
        pushType(errors, `${epPath}.url`, 'string');
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
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'payload must be an object' }] };
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
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
    errors.push({ path: 'proposals', message: 'required, non-empty array' });
  } else {
    if (proposals.length > MAX.proposals) {
      errors.push({
        path: 'proposals',
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
