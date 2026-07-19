// Shared read-side logic for results. Used by both the anonymous
// /api/v1/results/* routes (frontend-facing) and the API-key-gated
// /api/v1/public/results/* routes (integrator-facing).
//
// Both readers accept either the canonical Mongo `_id` or the upstream
// `proposalSource.externalBallotId` / `externalProposal.id` set by the
// proposals module at import time. The `canonical` field in the
// returned data carries the resolved `_id` so callers can populate the
// JSON `canonical` field and `Link: rel=canonical` header.

import { Result } from '../schema/Result.js';
import { Proposal } from '../schema/Proposal.js';
import { resolveBallot, resolveProposal } from './idResolver.js';

/**
 * Shape a single Result doc for wire response. Currently a passthrough
 * after stripping Mongo internals; exposed as a seam so future field
 * normalization (label localization, rounding, etc.) lives in one place.
 */
export function serializeResult(doc) {
  if (!doc) return null;
  const { __v, ...rest } = doc;
  return rest;
}

export async function readBallotResults(ballotId) {
  const resolved = await resolveBallot(ballotId, {
    selectFields: { _id: 1 },
  });
  if (!resolved) {
    return { error: { status: 404, message: 'Ballot not found' } };
  }
  if (resolved.ambiguous) {
    return {
      error: {
        status: 409,
        code: 'ID_COLLISION',
        message: 'External ballot id matches multiple ballots; use the canonical _id',
        candidates: resolved.ambiguous,
      },
    };
  }
  const canonicalId = resolved.doc._id;
  const proposals = await Proposal.find({ ballotId: canonicalId }, { _id: 1 }).lean();
  const ids = proposals.map((p) => p._id);
  const results = await Result.find({ proposalId: { $in: ids } }).lean();
  return {
    data: results.map(serializeResult),
    canonical: { id: String(canonicalId), source: resolved.source },
  };
}

export async function readProposalResult(proposalId) {
  const resolved = await resolveProposal(proposalId, {
    selectFields: { _id: 1 },
  });
  if (!resolved) {
    return { error: { status: 404, message: 'Proposal not found' } };
  }
  if (resolved.ambiguous) {
    return {
      error: {
        status: 409,
        code: 'ID_COLLISION',
        message: 'External proposal id matches multiple proposals; use the canonical _id',
        candidates: resolved.ambiguous,
      },
    };
  }
  const canonicalId = resolved.doc._id;
  const row = await Result.findOne({ proposalId: canonicalId }).lean();
  if (!row) return { error: { status: 404, message: 'No results yet' } };
  return {
    data: serializeResult(row),
    canonical: { id: String(canonicalId), source: resolved.source },
  };
}
