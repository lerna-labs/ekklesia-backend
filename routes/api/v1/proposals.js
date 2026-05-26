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
import {
  resolveBallot,
  resolveProposal,
  canonicalApiPath,
  setCanonicalLinkHeader,
} from "../../../helper/idResolver.js";

const router = Router();

router.get("/ballot/:ballotId", async (req, res) => {
  // Accept either canonical _id or upstream externalBallotId.
  const bRes = await resolveBallot(req.params.ballotId, {
    selectFields: "_id facets",
  });
  if (!bRes) {
    return res.status(404).json({
      status: "error",
      code: "BALLOT_NOT_FOUND",
      message: "Ballot not found",
    });
  }
  if (bRes.ambiguous) {
    return res.status(409).json({
      status: "error",
      code: "ID_COLLISION",
      message: "External ballot id matches multiple ballots; use the canonical _id",
      candidates: bRes.ambiguous,
    });
  }
  const ballot = bRes.doc;

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

  const payload = {
    status: "success",
    data,
    pagination: { total, page, limit },
    applied: { ...queryPlan.applied, search: search || null },
  };
  // When the ballot segment was addressed via externalBallotId, emit
  // the canonical _id URL so SEO + SPA history-replaceState consumers
  // can normalize.
  if (bRes.source === "external") {
    payload.canonical = canonicalApiPath(
      "proposals-by-ballot",
      String(ballot._id)
    );
    setCanonicalLinkHeader(res, payload.canonical);
  }
  return res.json(payload);
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /:proposalId — single proposal detail. Returns the full doc
// plus the parent ballot's facets[] so the detail page can render
// facet labels without a separate ballot fetch.
//
// The ID may be either the canonical Mongo `_id` or the upstream
// `externalProposal.id`. Internal _id wins on tie; ambiguous external
// matches return 409.
router.get("/:proposalId", async (req, res) => {
  const pRes = await resolveProposal(req.params.proposalId);
  if (!pRes) {
    return res.status(404).json({
      status: "error",
      code: "PROPOSAL_NOT_FOUND",
      message: "Proposal not found",
    });
  }
  if (pRes.ambiguous) {
    return res.status(409).json({
      status: "error",
      code: "ID_COLLISION",
      message:
        "External proposal id matches multiple proposals; use the canonical _id",
      candidates: pRes.ambiguous,
    });
  }
  const proposal = pRes.doc;
  const ballot = await Ballot.findById(proposal.ballotId)
    .select("_id title facets status source voterType voteWeighted")
    .lean();
  const payload = {
    status: "success",
    data: proposal,
    ballot: ballot || null,
  };
  if (pRes.source === "external") {
    payload.canonical = canonicalApiPath("proposal", String(proposal._id));
    setCanonicalLinkHeader(res, payload.canonical);
  }
  return res.json(payload);
});

export default router;
