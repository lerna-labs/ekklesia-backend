// v1 proposal endpoints. Presently exposes a ballot-scoped listing
// with facet-driven sort + filter. Per-proposal detail / results
// continue to live under /api/v0/proposals until we have a reason
// to re-shape them here.
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

  const filter = { ballotId: ballot._id, ...queryPlan.filter };
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
    applied: queryPlan.applied,
  });
});

export default router;
