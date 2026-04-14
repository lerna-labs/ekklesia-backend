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
import { writeFinalResult } from "../../../../crons/10minAggregateVotes.js";

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
    // Hydra /prepare returns: { txHash, policyId, fingerprint,
    //   definitionAssetName, instanceAssetName, ballotIpfsCid,
    //   timelockSlot, commitUtxos, ... }
    // Capture everything needed to drive the remaining lifecycle routes
    // without the admin having to know these values.
    if (data?.txHash) {
      ballot.prepareTxHash = data.txHash;
      ballot.prepareTxSubmittedAt = new Date();
    }
    if (data?.ballotCid || data?.ballotIpfsCid)
      ballot.ballotCid = data.ballotCid || data.ballotIpfsCid;
    if (data?.policyId || data?.instancePolicyId)
      ballot.instancePolicyId = data.policyId || data.instancePolicyId;
    if (data?.definitionAssetName) ballot.definitionAssetName = data.definitionAssetName;
    if (data?.instanceAssetName) ballot.instanceAssetName = data.instanceAssetName;
    if (data?.fingerprint) ballot.ballotFingerprint = data.fingerprint;
    if (data?.timelockSlot !== undefined) ballot.timelockSlot = data.timelockSlot;
    if (Array.isArray(data?.commitUtxos)) ballot.commitUtxos = data.commitUtxos;
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

/**
 * Populate Hydra-specific fields on the request body from the Ballot doc
 * when the admin hasn't provided them. Everything except operator secrets
 * (like `closeToken`) is derivable from what we stamped at /prepare.
 */
async function autoFillFromBallot(ballotId, body) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) return { error: { status: 404, message: "Ballot not found" } };

  const out = { ...body };
  if (!out.ballotId) out.ballotId = ballotId;
  if (!out.ballotPolicy && ballot.instancePolicyId) out.ballotPolicy = ballot.instancePolicyId;
  if (!out.ballotToken && ballot.instanceAssetName) out.ballotToken = ballot.instanceAssetName;
  if (!out.ballotName && ballot.definitionAssetName) out.ballotName = ballot.definitionAssetName;
  if (!out.ballotIpfsCid && ballot.ballotCid) out.ballotIpfsCid = ballot.ballotCid;
  if (!out.utxos && Array.isArray(ballot.commitUtxos) && ballot.commitUtxos.length) {
    out.utxos = ballot.commitUtxos.map((u) => ({
      txHash: u.txHash,
      outputIndex: u.outputIndex,
    }));
  }
  return { body: out, ballot };
}

/**
 * Factory for pass-through lifecycle endpoints. After auto-fill, anything in
 * `required` that's still missing fails locally with a clear 400 rather than
 * a 502 after a round-trip.
 */
function lifecycleRoute(method, required = []) {
  return async (req, res) => {
    const filled = await autoFillFromBallot(req.params.id, req.body || {});
    if (filled.error) return res.status(filled.error.status).json({ status: "error", message: filled.error.message });
    const missing = required.filter(
      (k) => filled.body[k] === undefined || filled.body[k] === null || filled.body[k] === ""
    );
    if (missing.length) {
      return res.status(400).json({
        status: "error",
        message: `Missing required field(s) for /${method}: ${missing.join(", ")}`,
      });
    }
    try {
      const client = await forBallot(req.params.id);
      const data = await client[method](filled.body);
      return res.json({ status: "success", hydra: data });
    } catch (err) {
      return handleHydraError(err, res);
    }
  };
}

/**
 * Mirror the current Hydra /head-info into the Ballot doc (hydraHeadId +
 * hydraHeadStatus) and optionally flip the user-facing `status` field to
 * reflect the lifecycle transition the caller just triggered.
 *
 * Best-effort — head-info failures are logged but don't fail the request.
 * Returns `{ hydraHeadId, hydraHeadStatus }` for the response payload.
 */
async function syncHeadStateToBallot(ballotId, client, { status } = {}) {
  let hydraHeadId = null;
  let hydraHeadStatus = null;
  try {
    const info = await client.headInfo();
    hydraHeadId = info?.headId || info?.hydraHeadId || null;
    hydraHeadStatus = info?.headStatus || info?.status || null;
  } catch (e) {
    console.warn(`[admin] head-info fetch failed: ${e.message}`);
  }

  const update = {};
  if (hydraHeadId) update.hydraHeadId = hydraHeadId;
  if (hydraHeadStatus) update.hydraHeadStatus = hydraHeadStatus;
  if (status) update.status = status;
  if (Object.keys(update).length) {
    await Ballot.updateOne({ _id: ballotId }, { $set: update });
  }
  return { hydraHeadId, hydraHeadStatus, status };
}

// `utxos`, `ballotPolicy`, `ballotToken` are auto-filled from the Ballot doc
// (written at /prepare). Admin only needs to override if running with custom
// state. After /start succeeds, query head-info and stamp hydraHeadId +
// hydraHeadStatus on the Ballot doc, and flip user-facing status → "live".
router.post("/:id/start", async (req, res) => {
  const filled = await autoFillFromBallot(req.params.id, req.body || {});
  if (filled.error) return res.status(filled.error.status).json({ status: "error", message: filled.error.message });
  const required = ["utxos", "ballotPolicy", "ballotToken"];
  const missing = required.filter(
    (k) => filled.body[k] === undefined || filled.body[k] === null || filled.body[k] === ""
  );
  if (missing.length) {
    return res.status(400).json({
      status: "error",
      message: `Missing required field(s) for /start: ${missing.join(", ")}`,
    });
  }
  try {
    const client = await forBallot(req.params.id);
    const data = await client.start(filled.body);
    const synced = await syncHeadStateToBallot(req.params.id, client, { status: "live" });
    return res.json({ status: "success", hydra: data, ballot: synced });
  } catch (err) {
    return handleHydraError(err, res);
  }
});
// /finalize — no body. Ballot identity lives in Hydra's in-memory cache
// from /start. Hydra response includes txHash, resultsHash,
// evidenceDirectoryCid, evidenceMerkleRoot, totalVoters, etc.
//
// Note: this is a standalone finalize (e.g. for mid-vote inspection).
// The canonical close path is the stepped /settle/* sequence below,
// which internally burns → finalizes → closes in the correct order.
router.post("/:id/finalize", async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.finalize();
    await writeFinalResult(req.params.id, data).catch((err) => {
      console.warn(`[admin/finalize] writeFinalResult failed: ${err.message}`);
    });
    const synced = await syncHeadStateToBallot(req.params.id, client);
    return res.json({ status: "success", hydra: data, ballot: synced });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// Stepped settlement — the only supported close path. Caller drives:
//   1) /settle/burn      (may loop internally — body: { batchSize? })
//   2) /settle/finalize  (no body; writes results datum)
//   3) /settle/close     (body: { closeToken }; closes the head)
//
// The top-level /close and monolithic /settle endpoints have been
// removed as unreliable.
// /settle/burn — no body. Response: { burned, failed, remaining, total,
// message }. Caller must loop on this endpoint until `remaining === 0`
// before proceeding to /settle/finalize.
router.post("/:id/settle/burn", async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleBurn();
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.post("/:id/settle/finalize", async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleFinalize();
    await writeFinalResult(req.params.id, data).catch((err) => {
      console.warn(`[admin/settle/finalize] writeFinalResult failed: ${err.message}`);
    });
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.post("/:id/settle/close", async (req, res) => {
  const closeToken = (req.body || {}).closeToken;
  if (!closeToken) {
    return res.status(400).json({ status: "error", message: "Missing required field: closeToken" });
  }
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleClose({ closeToken });
    const synced = await syncHeadStateToBallot(req.params.id, client, { status: "closed" });
    return res.json({ status: "success", hydra: data, ballot: synced });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// /count — burn all voter tokens. No body. Good for inspection between
// rounds; /settle/burn is the recommended stepped variant.
router.post("/:id/count", async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: "error", message: "Ballot not found" });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.count();
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// Queue + cache observability / maintenance
router.get("/:id/queue/status", async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.queueStatus();
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.post("/:id/queue/drain", async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.queueDrain(req.body || {});
    return res.json({ status: "success", hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

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
