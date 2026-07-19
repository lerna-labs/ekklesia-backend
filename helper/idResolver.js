// Dual-ID resolver for ballots and proposals.
//
// Lets every lookup site accept either:
//   - the canonical Mongo `_id` (24-char hex), or
//   - the upstream identifier the proposals module assigned at import
//     time (`proposalSource.externalBallotId` on Ballot,
//     `externalProposal.id` on Proposal).
//
// Behavior:
//   - Single Mongo query per call (`$or` over `_id` + external key).
//   - Internal `_id` always wins on tie — if the 24-hex input both
//     matches an `_id` and matches some other doc's external id, the
//     `_id` match is returned (callers see `source: 'internal'`).
//   - Up to 2 docs are fetched so the resolver can detect ambiguous
//     external-id collisions without paying for an unbounded read.
//   - `resolveProposal({ ballotId })` resolves the parent ballot
//     first (so scoping works whether the URL carries an internal or
//     external ballot id) and constrains the proposal lookup to that
//     ballot — the parent scope eliminates the realistic collision
//     surface (same upstream proposal id reused across ballots).
//
// Return shapes (uniform across resolveBallot / resolveProposal):
//   null                              — no match
//   { doc, source: 'internal' | 'external' }
//   { ambiguous: [_idString, ...] }   — multiple external matches, no
//                                       _id tiebreaker available
//
// Callers translate `null` → 404 and `{ ambiguous }` → 409
// (`code: "ID_COLLISION"`, body `{ candidates: [...] }`).

import mongoose from 'mongoose';
import { Ballot } from '../schema/Ballot.js';
import { Proposal } from '../schema/Proposal.js';

const MAX_INPUT_LENGTH = 128;

const BALLOT_EXTERNAL_KEY = 'proposalSource.externalBallotId';
const PROPOSAL_EXTERNAL_KEY = 'externalProposal.id';

function normalizeInput(input) {
  if (input == null) return null;
  // Accept ObjectId-like inputs (toString) as well as plain strings.
  const s = typeof input === 'string' ? input : String(input);
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > MAX_INPUT_LENGTH) return null;
  return trimmed;
}

/**
 * Resolve a ballot by `_id` or `proposalSource.externalBallotId`.
 *
 * `extraFilter` lets callers narrow the lookup (e.g. ballot adapters
 * pass `{ source: "legacy" }` so cross-adapter external-id reuse
 * doesn't trigger a 409).
 *
 * @param {string|mongoose.Types.ObjectId} input
 * @param {{ selectFields?: object|string, lean?: boolean, extraFilter?: object }} [opts]
 * @returns {Promise<null | { doc: object, source: 'internal'|'external' } | { ambiguous: string[] }>}
 */
export async function resolveBallot(input, opts = {}) {
  const { extraFilter, ...rest } = opts;
  return _resolveByKey(Ballot, BALLOT_EXTERNAL_KEY, input, {
    ...rest,
    scope: extraFilter || {},
  });
}

/**
 * Resolve a proposal by `_id` or `externalProposal.id`.
 *
 * If `ballotId` is supplied, the parent ballot is resolved first
 * (using the same dual-id rule) and the proposal lookup is scoped
 * to that ballot. A null/ambiguous parent surfaces directly to the
 * caller (treat as 404 / 409 for the ballot segment).
 *
 * @param {string|mongoose.Types.ObjectId} input
 * @param {{ ballotId?: string, selectFields?: object|string, lean?: boolean }} [opts]
 */
export async function resolveProposal(input, opts = {}) {
  const scope = {};
  if (opts.ballotId !== undefined && opts.ballotId !== null) {
    const parent = await resolveBallot(opts.ballotId, {
      selectFields: { _id: 1 },
    });
    if (!parent || parent.ambiguous) return parent;
    scope.ballotId = parent.doc._id;
  }
  const sub = await _resolveByKey(Proposal, PROPOSAL_EXTERNAL_KEY, input, { ...opts, scope });
  return sub;
}

async function _resolveByKey(Model, externalKey, rawInput, opts = {}) {
  const input = normalizeInput(rawInput);
  if (!input) return null;

  const clauses = [];
  const isOid = mongoose.isValidObjectId(input);
  if (isOid) {
    clauses.push({ _id: new mongoose.Types.ObjectId(input) });
  }
  clauses.push({ [externalKey]: input });

  const scope = opts.scope || {};
  const filter = { ...scope, $or: clauses };

  const projection = opts.selectFields || null;
  const options = { lean: opts.lean !== false };

  // limit(2) is enough to spot ambiguity without an unbounded fetch.
  const docs = await Model.find(filter, projection, options).limit(2);

  if (!docs || docs.length === 0) return null;

  if (docs.length === 1) {
    const doc = docs[0];
    const internal = isOid && String(doc._id) === input;
    return { doc, source: internal ? 'internal' : 'external' };
  }

  // 2+ matches — prefer an _id hit if present (canonical wins).
  if (isOid) {
    const internalHit = docs.find((d) => String(d._id) === input);
    if (internalHit) return { doc: internalHit, source: 'internal' };
  }
  return { ambiguous: docs.map((d) => String(d._id)) };
}

/**
 * Canonical SPA path for the resolved pair. Mirrors the SPA routes
 * registered in server.js. Returns null when there's nothing to
 * canonicalize.
 *
 * @param {{ ballot?: object, proposal?: object, resultsView?: boolean }} args
 */
export function canonicalSpaPath({ ballot, proposal, resultsView = false } = {}) {
  if (!ballot) return null;
  const bId = String(ballot._id);
  if (!proposal) return `/ballots/${bId}`;
  const pId = String(proposal._id);
  return resultsView
    ? `/ballots/${bId}/proposals/${pId}/results`
    : `/ballots/${bId}/proposals/${pId}`;
}

/**
 * Canonical API path for JSON responses. Used to populate the
 * `canonical` field on payloads whose input was resolved via an
 * external id.
 *
 * `kind` selects the resource family:
 *   "ballot"             → /api/v1/ballots/<id>
 *   "ballot-archive"     → /api/v1/ballots/<id>/archive
 *   "ballot-certified"   → /api/v1/ballots/<id>/certified
 *   "ballot-question"    → /api/v1/ballots/<id>/questions/<qid>/content
 *                          (requires `qid` opt)
 *   "proposal"           → /api/v1/proposals/<id>
 *   "proposals-by-ballot"→ /api/v1/proposals/ballot/<id>
 */
export function canonicalApiPath(kind, id, opts = {}) {
  if (!id) return null;
  switch (kind) {
    case 'ballot':
      return `/api/v1/ballots/${id}`;
    case 'ballot-archive':
      return `/api/v1/ballots/${id}/archive`;
    case 'ballot-certified':
      return `/api/v1/ballots/${id}/certified`;
    case 'ballot-question':
      return opts.qid ? `/api/v1/ballots/${id}/questions/${opts.qid}/content` : null;
    case 'proposal':
      return `/api/v1/proposals/${id}`;
    case 'proposals-by-ballot':
      return `/api/v1/proposals/ballot/${id}`;
    default:
      return null;
  }
}

/**
 * Set the `Link: <canonical>; rel="canonical"` header on a response.
 * No-op when `canonicalUrl` is falsy, so callers can pass through
 * `canonicalSpaPath(...)` unchecked.
 */
export function setCanonicalLinkHeader(res, canonicalUrl) {
  if (!canonicalUrl) return;
  res.set('Link', `<${canonicalUrl}>; rel="canonical"`);
}

// Exposed for tests
export const _internals = { _resolveByKey, normalizeInput };
