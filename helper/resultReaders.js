// Shared read-side logic for results. Used by both the anonymous
// /api/v1/results/* routes (frontend-facing) and the API-key-gated
// /api/v1/public/results/* routes (integrator-facing).

import mongoose from "mongoose";
import { Result } from "../schema/Result.js";
import { Proposal } from "../schema/Proposal.js";

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
  if (!mongoose.isValidObjectId(ballotId)) {
    return { error: { status: 400, message: "invalid ballotId" } };
  }
  const proposals = await Proposal.find({ ballotId }, { _id: 1 }).lean();
  const ids = proposals.map((p) => p._id);
  const results = await Result.find({ proposalId: { $in: ids } }).lean();
  return { data: results.map(serializeResult) };
}

export async function readProposalResult(proposalId) {
  if (!mongoose.isValidObjectId(proposalId)) {
    return { error: { status: 400, message: "invalid proposalId" } };
  }
  const row = await Result.findOne({ proposalId }).lean();
  if (!row) return { error: { status: 404, message: "No results yet" } };
  return { data: serializeResult(row) };
}
