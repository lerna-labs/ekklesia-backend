// Admin endpoints for Hydra-backed ballot lifecycle.
//
// All routes require admin auth. The backend forwards to the Hydra instance
// registered for the ballot (or a default instance for /prepare).
//
//   POST /api/v1/admin/ballots/:id/prepare   — mint (600)/(601); stamp Hydra metadata on Ballot
//   POST /api/v1/admin/ballots/:id/start     — commit (601) into head, open voting
//   POST /api/v1/admin/ballots/:id/close     — close head
//   POST /api/v1/admin/ballots/:id/finalize  — tally, update (601) datum
//   POST /api/v1/admin/ballots/:id/settle    — finalize + count + close
//   GET  /api/v1/admin/ballots/:id/head-info — Hydra head info passthrough

import { Router } from "express";
import { Ballot } from "../../../../schema/Ballot.js";
import { isAdmin } from "../../../../helper/adminAuth.js";
import {
  forBallot,
  forEndpoint,
  HydraClientError,
} from "../../../../helper/hydraClient.js";

const router = Router();

router.use(isAdmin);

function handleHydraError(err, res) {
  if (err instanceof HydraClientError) {
    return res.status(err.status && err.status < 600 ? 502 : 502).json({
      status: "error",
      code: err.code || null,
      message: err.message,
      upstream: err.data ?? null,
    });
  }
  console.error("admin lifecycle error:", err);
  return res.status(500).json({ status: "error", message: err.message || "Server error" });
}

// POST /:id/prepare
//
// body: {
//   endpoint?: string,     // Hydra instance URL; defaults to HYDRA_DEFAULT_ENDPOINT
//   ballotCid?: string,    // IPFS CID of the ballot definition (optional; Hydra can resolve)
//   // Any additional fields pass through to Hydra /prepare
//   ...payload
// }
router.post("/:id/prepare", async (req, res) => {
  try {
    const ballot = await Ballot.findById(req.params.id);
    if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });

    const endpoint = req.body.endpoint || ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
    if (!endpoint) {
      return res.status(400).json({
        status: "error",
        message: "No hydra endpoint provided or configured (HYDRA_DEFAULT_ENDPOINT)",
      });
    }

    const client = forEndpoint(endpoint);
    const { endpoint: _skip, ...hydraBody } = req.body;
    const data = await client.prepare(hydraBody);

    ballot.source = "hydra";
    ballot.hydraEndpoint = endpoint;
    if (data?.ballotCid) ballot.ballotCid = data.ballotCid;
    if (data?.instancePolicyId) ballot.instancePolicyId = data.instancePolicyId;
    if (data?.hydraHeadId) ballot.hydraHeadId = data.hydraHeadId;
    await ballot.save();

    return res.json({
      status: "success",
      ballot: {
        id: ballot._id.toString(),
        source: ballot.source,
        hydraEndpoint: ballot.hydraEndpoint,
        ballotCid: ballot.ballotCid,
        instancePolicyId: ballot.instancePolicyId,
        hydraHeadId: ballot.hydraHeadId,
      },
      hydra: data,
    });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// Helper factory for pass-through lifecycle endpoints.
function lifecycleRoute(method) {
  return async (req, res) => {
    try {
      const client = await forBallot(req.params.id);
      const data = await client[method](req.body || {});
      return res.json({ status: "success", hydra: data });
    } catch (err) {
      return handleHydraError(err, res);
    }
  };
}

router.post("/:id/start", lifecycleRoute("start"));
router.post("/:id/close", lifecycleRoute("close"));
router.post("/:id/finalize", lifecycleRoute("finalize"));
router.post("/:id/settle", lifecycleRoute("settle"));

router.get("/:id/head-info", async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.headInfo();
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

export default router;
