// Reads legacy ballots from the local Mongo Ballot collection.
// Pre-Hydra ballots (source === "legacy") are served here in read-only mode.

import { Ballot } from "../../schema/Ballot.js";
import { resolveBallot } from "../idResolver.js";

export const source = "legacy";

/**
 * Filter in Mongo query form that restricts to this adapter's ballots.
 */
export function ownershipMatch() {
  return { source: "legacy" };
}

/**
 * List ballots. Input filter is already normalized by the dispatcher.
 * Returns { items, total } in unified shape.
 */
export async function list({ filter = {}, sort = { votePeriodEnd: -1 }, skip = 0, limit = 10 } = {}) {
  const match = { ...ownershipMatch(), ...filter };

  const total = await Ballot.countDocuments(match);

  const docs = await Ballot.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "proposals",
        localField: "_id",
        foreignField: "ballotId",
        as: "proposals",
      },
    },
    {
      $addFields: {
        proposalCount: { $size: "$proposals" },
        singleProposal: {
          $cond: {
            if: { $eq: [{ $size: "$proposals" }, 1] },
            then: { $arrayElemAt: ["$proposals._id", 0] },
            else: null,
          },
        },
      },
    },
    { $sort: sort },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        voterValidationScript: 0,
        rollupScript: 0,
        voteAuthorityId: 0,
        voteAuthorityAddress: 0,
        proposalPeriodStart: 0,
        proposalPeriodEnd: 0,
        startupScript: 0,
        startupAt: 0,
        resultTxHash: 0,
        proposals: 0,
      },
    },
  ]);

  return { items: docs.map(toUnified), total };
}

/**
 * Resolve by canonical `_id` or upstream `proposalSource.externalBallotId`,
 * scoped to legacy rows so cross-adapter external-id reuse can't trigger
 * a 409 here. The dispatcher walks adapters in order and passes the
 * first hit through.
 *
 * Ambiguity is propagated via a `__ambiguous` marker so the dispatcher
 * can render 409 instead of swallowing the conflict as a 404.
 */
export async function get(id) {
  const result = await resolveBallot(id, {
    extraFilter: ownershipMatch(),
  });
  if (!result) return null;
  if (result.ambiguous) return { __ambiguous: result.ambiguous };
  return toUnified(result.doc);
}

/**
 * Normalize to the unified response shape. Hydra-specific fields are exposed
 * as a `hydra` sub-object so callers can gate rendering on `source`.
 */
export function toUnified(doc) {
  return {
    id: doc._id?.toString() ?? doc.id,
    source: "legacy",
    title: doc.title,
    description: doc.description,
    status: doc.status,
    voterType: doc.voterType,
    voterGroups: Array.isArray(doc.voterGroups) ? doc.voterGroups : [],
    voterDescription: doc.voterDescription,
    voteWeighted: doc.voteWeighted,
    votePeriodStart: doc.votePeriodStart,
    votePeriodEnd: doc.votePeriodEnd,
    voteFilters: doc.voteFilters,
    ipfsHash: doc.ipfsHash ?? null,
    proposalCount: doc.proposalCount ?? null,
    singleProposal: doc.singleProposal
      ? doc.singleProposal.toString()
      : null,
    hydra: null,
    provisionalResultsEnabled: doc.provisionalResultsEnabled ?? false,
    resultsCalculationMode: doc.resultsCalculationMode ?? "standard",
    proposalSource: doc.proposalSource?.moduleId ? doc.proposalSource : null,
    facets: Array.isArray(doc.facets) ? doc.facets : [],
    votingPowerSource: doc.votingPowerSource
      ? {
          type: doc.votingPowerSource.type || "snapshot",
          uploadedAt: doc.votingPowerSource.uploadedAt || null,
        }
      : null,
    // Authority-certification surface — see hydraAdapter.js for
    // rationale. Legacy ballots can still carry a certification
    // (e.g. historical ballots that get re-certified after a
    // ruleset change) so the field is exposed on both adapters
    // for parity.
    certification: {
      certified: typeof doc.currentCertifiedVersion === "number",
      version: doc.currentCertifiedVersion ?? null,
      narrative: doc.authorityNarrative ?? null,
    },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
