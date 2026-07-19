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

import { Router } from 'express';
import { Ballot } from '../../../../schema/Ballot.js';
import { isAdmin } from '../../../../helper/adminAuth.js';
import { adminOrScope } from '../../../../helper/compositeAuth.js';
import { ballotImportLimiter } from '../../../../helper/rateLimiters.js';
import { validateCompiledBallot } from '../../../../helper/compiledBallot/validator.js';
import {
  writeCompiledBallot,
  CompiledBallotWriteError,
} from '../../../../helper/compiledBallot/writer.js';
import { forBallot, forEndpoint, HydraClientError } from '../../../../helper/hydraClient.js';
import { writeFinalResult } from '../../../../crons/10minAggregateVotes.js';
import { certifyBallot, CertifyError } from '../../../../helper/results/certify.js';
import { VoterPowerSnapshot } from '../../../../schema/VoterPowerSnapshot.js';
import { ImportedBallotPayload } from '../../../../schema/ImportedBallotPayload.js';
import { resolveBallot } from '../../../../helper/idResolver.js';
import crypto from 'node:crypto';

const router = Router();

// All admin lifecycle handlers below address ballots through `:id`.
// Resolve once per request (`router.param`), accept either the
// canonical Mongo `_id` or the upstream `proposalSource.externalBallotId`
// the proposals module pushed at import time, then rewrite
// `req.params.id` to the canonical value so every downstream
// `Ballot.findById(req.params.id)` / `forBallot(req.params.id)` call
// addresses the real row without any handler-body churn.
router.param('id', async (req, res, next, id) => {
  try {
    const result = await resolveBallot(id);
    if (!result) {
      return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    }
    if (result.ambiguous) {
      return res.status(409).json({
        status: 'error',
        code: 'ID_COLLISION',
        message: 'External ballot id matches multiple ballots; use the canonical _id',
        candidates: result.ambiguous,
      });
    }
    req.params.id = String(result.doc._id);
    req.ballotResolvedFrom = result.source; // 'internal' | 'external'
    return next();
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// POST /import — accepts a CompiledBallot (v1) from either a proposals
// module (API key with `write:ballot-import`) or an admin (JWT). Must
// be registered BEFORE router.use(isAdmin) so the composite auth can
// run in place of the global admin-only gate.
//
// Body: CompiledBallot (see helper/compiledBallot/schema.js)
// Returns: { ballotId, created, proposalsImported, schemaVersion }
// 409 if the target ballot is already live/closed.
router.post(
  '/import',
  ballotImportLimiter,
  adminOrScope('write:ballot-import'),
  async (req, res) => {
    const payload = req.body;
    const validation = validateCompiledBallot(payload);
    if (!validation.ok) {
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_FAILED',
        message: 'Compiled ballot payload failed validation',
        errors: validation.errors,
      });
    }

    const authCtx = {
      method: req.auth.kind === 'apiKey' ? 'push' : 'upload',
      importedBy: req.auth.kind === 'apiKey' ? req.auth.prefix : req.auth.userId,
    };

    try {
      const result = await writeCompiledBallot(payload, authCtx);
      return res.status(result.created ? 201 : 200).json({
        status: 'success',
        ...result,
      });
    } catch (err) {
      if (err instanceof CompiledBallotWriteError) {
        return res.status(err.status).json({
          status: 'error',
          code: err.code,
          message: err.message,
        });
      }
      console.error('[ballots/import] error:', err);
      return res.status(500).json({ status: 'error', code: 'INTERNAL', message: 'Server error' });
    }
  },
);

router.use(isAdmin);

function handleHydraError(err, res) {
  if (err instanceof HydraClientError) {
    // 409 CONFLICT from Hydra is operator-actionable (HEAD_NOT_CLOSEABLE
    // from driveHeadToFinal, or "finalize-response.json already present in
    // staging" from /start post-finalize — see the BACKEND_TALLY_DERIVATIONS
    // contract). Preserve the upstream status + code so the admin can tell
    // "don't retry — archive the prior staging dir / reset the head" apart
    // from a generic upstream failure.
    if (err.status === 409) {
      return res.status(409).json({
        status: 'error',
        code: err.code || 'CONFLICT',
        message:
          err.message ||
          'Hydra rejected the request as a conflict — do not retry without operator review.',
        upstream: err.data ?? null,
      });
    }
    return res.status(err.status && err.status < 600 ? 502 : 502).json({
      status: 'error',
      code: err.code || null,
      message: err.message,
      upstream: err.data ?? null,
    });
  }
  console.error('admin lifecycle error:', err);
  return res.status(500).json({ status: 'error', message: err.message || 'Server error' });
}

// POST /:id/prepare
//
// body: {
//   endpoint?: string,     // Hydra instance URL; defaults to HYDRA_DEFAULT_ENDPOINT
//   ballotCid?: string,    // IPFS CID of the ballot definition (optional; Hydra can resolve)
//   // Any additional fields pass through to Hydra /prepare
//   ...payload
// }
router.post('/:id/prepare', async (req, res) => {
  try {
    const ballot = await Ballot.findById(req.params.id);
    if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });

    const endpoint =
      req.body.endpoint || ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
    if (!endpoint) {
      return res.status(400).json({
        status: 'error',
        message: 'No hydra endpoint provided or configured (HYDRA_DEFAULT_ENDPOINT)',
      });
    }

    const client = forEndpoint(endpoint);
    const { endpoint: _skip, ...hydraBody } = req.body;
    const data = await client.prepare(hydraBody);

    ballot.source = 'hydra';
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
      status: 'success',
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
  if (!ballot) return { error: { status: 404, message: 'Ballot not found' } };

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
    if (filled.error)
      return res
        .status(filled.error.status)
        .json({ status: 'error', message: filled.error.message });
    const missing = required.filter(
      (k) => filled.body[k] === undefined || filled.body[k] === null || filled.body[k] === '',
    );
    if (missing.length) {
      return res.status(400).json({
        status: 'error',
        message: `Missing required field(s) for /${method}: ${missing.join(', ')}`,
      });
    }
    try {
      const client = await forBallot(req.params.id);
      const data = await client[method](filled.body);
      return res.json({ status: 'success', hydra: data });
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
router.post('/:id/start', async (req, res) => {
  const filled = await autoFillFromBallot(req.params.id, req.body || {});
  if (filled.error)
    return res.status(filled.error.status).json({ status: 'error', message: filled.error.message });
  const required = ['utxos', 'ballotPolicy', 'ballotToken'];
  const missing = required.filter(
    (k) => filled.body[k] === undefined || filled.body[k] === null || filled.body[k] === '',
  );
  if (missing.length) {
    return res.status(400).json({
      status: 'error',
      message: `Missing required field(s) for /start: ${missing.join(', ')}`,
    });
  }
  try {
    const client = await forBallot(req.params.id);
    const data = await client.start(filled.body);
    const synced = await syncHeadStateToBallot(req.params.id, client, { status: 'live' });
    return res.json({ status: 'success', hydra: data, ballot: synced });
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
router.post('/:id/finalize', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.finalize();
    await writeFinalResult(req.params.id, data).catch((err) => {
      console.warn(`[admin/finalize] writeFinalResult failed: ${err.message}`);
    });
    const synced = await syncHeadStateToBallot(req.params.id, client);
    return res.json({ status: 'success', hydra: data, ballot: synced });
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
router.post('/:id/settle/burn', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleBurn();
    return res.json({ status: 'success', hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// Finalize is the authoritative end-of-vote event: the tally is fixed,
// `resultsHash` + `evidenceMerkleRoot` are anchored on-chain, and the (601)
// datum carries the committed result. Flip the ballot to "closed" here so
// downstream consumers don't block on the subsequent L1 cleanup in /settle/close.
router.post('/:id/settle/finalize', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleFinalize();
    await writeFinalResult(req.params.id, data).catch((err) => {
      console.warn(`[admin/settle/finalize] writeFinalResult failed: ${err.message}`);
    });
    const synced = await syncHeadStateToBallot(req.params.id, client, { status: 'closed' });
    return res.json({ status: 'success', hydra: data, ballot: synced });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.post('/:id/settle/close', async (req, res) => {
  const closeToken = (req.body || {}).closeToken;
  if (!closeToken) {
    return res.status(400).json({ status: 'error', message: 'Missing required field: closeToken' });
  }
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.settleClose({ closeToken });
    // Ballot was already flipped to "closed" by /settle/finalize. Here we only
    // refresh the head-state mirror (hydraHeadId + hydraHeadStatus) so the Ballot
    // doc reflects FINAL on the Hydra side.
    const synced = await syncHeadStateToBallot(req.params.id, client);
    return res.json({ status: 'success', hydra: data, ballot: synced });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// POST /:id/results/recover — re-run the finalize bookkeeping when the
// /settle/finalize HTTP call completed server-side but the backend never
// saw the response (client timeout, proxy drop, gateway restart). Calls
// Hydra `GET /results` to retrieve the last finalize envelope byte-identical
// and re-runs `writeFinalResult` so provenance and tally derivation match
// what would have landed on a clean /settle/finalize. Idempotent — safe to
// call repeatedly; the Result docs upsert in place.
//
// 404 when Hydra has no persisted finalize response (no finalize has run in
// the current staging directory).
router.post('/:id/results/recover', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.getResults();
    await writeFinalResult(req.params.id, data).catch((err) => {
      console.warn(`[admin/results/recover] writeFinalResult failed: ${err.message}`);
    });
    // Same status-flip as /settle/finalize — the ballot is authoritatively
    // closed once the finalize envelope is in hand, regardless of whether
    // /settle/close ever completed.
    const synced = await syncHeadStateToBallot(req.params.id, client, { status: 'closed' });
    return res.json({ status: 'success', hydra: data, ballot: synced });
  } catch (err) {
    if (err instanceof HydraClientError && err.status === 404) {
      return res.status(404).json({
        status: 'error',
        code: err.code || 'NOT_FOUND',
        message:
          'No finalize response persisted on Hydra — /settle/finalize must run before recovery.',
      });
    }
    return handleHydraError(err, res);
  }
});

// /count — burn all voter tokens. No body. Good for inspection between
// rounds; /settle/burn is the recommended stepped variant.
router.post('/:id/count', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id).lean();
  if (!ballot) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
  try {
    const client = await forBallot(req.params.id);
    const data = await client.count();
    return res.json({ status: 'success', hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// Queue + cache observability / maintenance
router.get('/:id/queue/status', async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.queueStatus();
    return res.json({ status: 'success', hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.post('/:id/queue/drain', async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.queueDrain(req.body || {});
    return res.json({ status: 'success', hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

router.get('/:id/head-info', async (req, res) => {
  try {
    const client = await forBallot(req.params.id);
    const data = await client.headInfo();
    return res.json({ status: 'success', hydra: data });
  } catch (err) {
    return handleHydraError(err, res);
  }
});

// POST /:id/voting-power
//
// Upload an authoritative per-voter voting-power snapshot for a ballot.
// Switches Ballot.votingPowerSource.type to "uploaded" — the cron
// stops touching this ballot, and read endpoints serve the uploaded
// rows as-is. Re-uploadable for corrections; each upload is archived
// to ImportedBallotPayload.
//
// body: {
//   epoch?: number,                 // Cardano epoch the snapshot was taken at
//   snapshotMethod?: string,        // free-form description ("drep-stake-distribution", etc.)
//   voters: Array<{ userId, voterGroup, votingPower }>,
// }
//
// Atomic replace: deletes all existing VoterPowerSnapshot rows for the
// ballot before inserting the uploaded set. Validation errors return
// 400 with a per-row error list.
router.post('/:id/voting-power', async (req, res) => {
  const ballot = await Ballot.findById(req.params.id);
  if (!ballot) {
    return res.status(404).json({
      status: 'error',
      code: 'BALLOT_NOT_FOUND',
      message: 'Ballot not found',
    });
  }

  const { voters, epoch, snapshotMethod } = req.body || {};
  if (!Array.isArray(voters) || voters.length === 0) {
    return res.status(400).json({
      status: 'error',
      code: 'BAD_INPUT',
      message: 'voters[] required (non-empty)',
    });
  }

  const errors = [];
  const seen = new Set();
  voters.forEach((v, i) => {
    if (!v || typeof v !== 'object') {
      errors.push({ path: `voters[${i}]`, message: 'must be an object' });
      return;
    }
    if (typeof v.userId !== 'string' || v.userId.length === 0) {
      errors.push({ path: `voters[${i}].userId`, message: 'required string' });
    }
    if (typeof v.voterGroup !== 'string' || v.voterGroup.length === 0) {
      errors.push({ path: `voters[${i}].voterGroup`, message: 'required string' });
    }
    if (typeof v.votingPower !== 'number' || !Number.isFinite(v.votingPower) || v.votingPower < 0) {
      errors.push({
        path: `voters[${i}].votingPower`,
        message: 'must be a non-negative finite number (lovelace)',
      });
    }
    if (v.userId && seen.has(v.userId)) {
      errors.push({ path: `voters[${i}].userId`, message: `duplicate userId "${v.userId}"` });
    }
    if (v.userId) seen.add(v.userId);
  });
  if (errors.length > 0) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_FAILED',
      message: 'voting-power upload payload failed validation',
      errors,
    });
  }

  const now = new Date();
  const adminId = req.auth?.userId || 'admin';

  const checksum = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

  // Atomic replace. No Mongo transaction (dev/standalone friendliness;
  // matches compiledBallot writer). Failure between delete and
  // insertMany would leave the ballot empty, which the snapshot reader
  // handles gracefully (returns zeros).
  try {
    await VoterPowerSnapshot.deleteMany({ ballotId: ballot._id });
    const docs = voters.map((v) => ({
      ballotId: ballot._id,
      userId: v.userId,
      voterGroup: v.voterGroup,
      votingPower: v.votingPower,
      source: 'uploaded',
      computedAt: now,
      computedBy: `admin:${adminId}`,
    }));
    await VoterPowerSnapshot.insertMany(docs, { ordered: true });

    ballot.votingPowerSource = {
      type: 'uploaded',
      scriptName: ballot.votingPowerSource?.scriptName || ballot.voterValidationScript || null,
      uploadedAt: now,
      uploadedBy: adminId,
      uploadCid: ballot.votingPowerSource?.uploadCid || null,
    };
    await ballot.save();

    // Audit row in the ImportedBallotPayload table — re-using the audit
    // surface from the proposal-import work. importMethod tagged as
    // "upload" since it's the same shape (admin JWT push).
    await ImportedBallotPayload.create({
      ballotId: ballot._id,
      schemaVersion: 'voting-power-1',
      importMethod: 'upload',
      importedBy: adminId,
      source: {
        moduleId: 'voting-power',
        externalBallotId: ballot._id.toString(),
        version: epoch ? `epoch:${epoch}` : null,
      },
      checksum,
      payload: { epoch, snapshotMethod, voters },
    });

    return res.status(201).json({
      status: 'success',
      ballotId: ballot._id.toString(),
      votersWritten: docs.length,
      uploadedAt: now,
    });
  } catch (err) {
    console.error('[admin/voting-power] upload failed:', err);
    return res.status(500).json({
      status: 'error',
      code: 'INTERNAL',
      message: err.message || 'Server error',
    });
  }
});

// POST /:id/certify — voting-authority certification ingest.
//
// Body (at least one of `snapshot` or `narrative` required):
// {
//   snapshotUrl?: string,              // URL the authority published at (informational)
//   snapshot?: {                       // full re-weighting payload
//     ballotId?: string,               // echoed; must match path param when set
//     authority?: string,              // informational; matches Ballot.voteAuthorityId
//     snapshotEpoch?: number,
//     voters: [{ voterId, votingPower: "<lovelace>", eligible: boolean }, ...],
//   },
//   narrative?: { url: string, label: string },
// }
//
// Full snapshot: flips every Result doc to `source: "certified"`,
// writes `certifiedResults*` + the latest-best `results*` fields, and
// bumps `Ballot.currentCertifiedVersion`.
//
// Narrative-only (no `snapshot`): records a CertifiedSnapshot row
// with `narrativeOnly: true` and updates `Ballot.authorityNarrative`,
// without flipping Result.source.
//
// Versioning: append-only, monotonic per ballot. Restatements land
// as version N+1. Identical payload bytes short-circuit to the
// existing version (idempotent by blake2b_256 of canonical JSON).
router.post('/:id/certify', async (req, res) => {
  try {
    // `req.user.userId` is set by the isAdmin middleware; fall back to
    // "admin" when the JWT shape is unexpected so the audit row still
    // captures who-ish submitted (avoids null-violating required field).
    const submittedBy = req.user?.userId || req.user?.sub || 'admin';
    const outcome = await certifyBallot({
      ballotId: req.params.id,
      submittedBy,
      source: 'api',
      chainTxHash: null,
      payload: req.body || {},
    });
    return res.json({ status: 'success', ...outcome });
  } catch (err) {
    if (err instanceof CertifyError) {
      const status =
        err.code === 'BALLOT_NOT_FOUND'
          ? 404
          : err.code === 'SNAPSHOT_COVERAGE_INCOMPLETE'
            ? 409
            : err.code === 'AUDIT_FETCH_FAILED'
              ? 502
              : 400;
      return res.status(status).json({
        status: 'error',
        code: err.code,
        message: err.message,
        details: err.details,
      });
    }
    console.error('[admin/certify] failed:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Server error',
    });
  }
});

export default router;
