// v1 proposal endpoints.
//
//   GET /api/v1/proposals/:proposalId
//     Single proposal detail + parent ballot sidecar (facets, status, etc.)
//
//   GET /api/v1/proposals/ballot/:ballotId
//     ?sort=<facetKey>&dir=<asc|desc>
//     ?filter[<facetKey>]=<csv>
//     ?page=<n>&limit=<n>   (pagination; default 1 / 25, max 100)
//
// Response shape:
//   {
//     data: [...proposals],
//     pagination: { total, page, limit },
//     applied: { filters, sort }  // echoed so the frontend can
//                                  reflect active state
//   }

import { Router } from "express";
import { Ballot } from "../../../schema/Ballot.js";
import { Proposal } from "../../../schema/Proposal.js";
import {
  buildFacetQuery,
  FacetQueryError,
} from "../../../helper/facets/queryAdapter.js";

const router = Router();

router.get("/ballot/:ballotId", async (req, res) => {
  const ballot = await Ballot.findById(req.params.ballotId)
    .select("_id facets")
    .lean();
  if (!ballot) {
    return res.status(404).json({
      status: "error",
      code: "BALLOT_NOT_FOUND",
      message: "Ballot not found",
    });
  }

  let queryPlan;
  try {
    queryPlan = buildFacetQuery(ballot, req.query);
  } catch (err) {
    if (err instanceof FacetQueryError) {
      return res.status(400).json({
        status: "error",
        code: err.code,
        path: err.path,
        message: err.message,
      });
    }
    throw err;
  }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 25, 1),
    100
  );

  // Free-text search across title + summary + authors.name. Case-
  // insensitive regex — good enough for demo/governance scale; a
  // proper $text index can be added later if it becomes a bottleneck.
  // Rationale is deliberately excluded (too long, causes false
  // positives on common words).
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const searchClause = search
    ? {
        $or: [
          { title: { $regex: escapeRegex(search), $options: "i" } },
          { summary: { $regex: escapeRegex(search), $options: "i" } },
          { "authors.name": { $regex: escapeRegex(search), $options: "i" } },
        ],
      }
    : null;

  const filter = {
    ballotId: ballot._id,
    ...queryPlan.filter,
    ...(searchClause || {}),
  };
  const [data, total] = await Promise.all([
    Proposal.find(filter)
      .sort(queryPlan.sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Proposal.countDocuments(filter),
  ]);

  return res.json({
    status: "success",
    data,
    pagination: { total, page, limit },
    applied: { ...queryPlan.applied, search: search || null },
  });
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /:proposalId — single proposal detail. Returns the full doc
// plus the parent ballot's facets[] so the detail page can render
// facet labels without a separate ballot fetch.
router.get("/:proposalId", async (req, res) => {
  const proposal = await Proposal.findById(req.params.proposalId).lean();
  if (!proposal) {
    return res.status(404).json({
      status: "error",
      code: "PROPOSAL_NOT_FOUND",
      message: "Proposal not found",
    });
  }
  const ballot = await Ballot.findById(proposal.ballotId)
    .select("_id title facets status source voterType voteWeighted")
    .lean();
  return res.json({
    status: "success",
    data: proposal,
    ballot: ballot || null,
  });
});

export default router;
