// Anonymous-readable results surface. Served with a short cache TTL so
// the frontend can poll without hammering Mongo. Provisional tallies
// update every ~10 min via the cron; final tallies overwrite on /finalize.
//
// The API-key-gated integrator copy lives at /api/v1/public/results.

import { Router } from 'express';
import { cacheControl } from '../../../helper/cacheControl.js';
import { readBallotResults, readProposalResult } from '../../../helper/resultReaders.js';
import { aggregationLimiter } from '../../../helper/rateLimiters.js';
import { canonicalApiPath, setCanonicalLinkHeader } from '../../../helper/idResolver.js';

const router = Router();

router.use(cacheControl(30)); // 30s — fine-grained enough for polling, short enough that a /finalize write lands quickly
// Results reads run a multi-stage Mongo aggregation per request and the
// 30s cache only helps repeat callers. Tighter bucket so a single attacker
// IP can't keep the aggregation pipeline busy.
router.use(aggregationLimiter);

// Emit `canonical` JSON field + `Link: rel=canonical` header whenever
// the caller addressed a row via its upstream `externalBallotId` /
// `externalProposal.id`. Cheap to do at the route layer because the
// reader already returned the resolved `_id` for us.
function applyCanonical(req, res, result, kind) {
  if (result.canonical?.source !== 'external') return;
  const path = canonicalApiPath(kind, result.canonical.id);
  setCanonicalLinkHeader(res, path);
  result.canonical = path;
}

router.get('/ballot/:ballotId', async (req, res) => {
  const result = await readBallotResults(req.params.ballotId);
  if (result.error) {
    return res.status(result.error.status).json({
      status: 'error',
      code: result.error.code,
      message: result.error.message,
      candidates: result.error.candidates,
    });
  }
  applyCanonical(req, res, result, 'ballot');
  return res.json(result);
});

router.get('/proposal/:proposalId', async (req, res) => {
  const result = await readProposalResult(req.params.proposalId);
  if (result.error) {
    return res.status(result.error.status).json({
      status: 'error',
      code: result.error.code,
      message: result.error.message,
      candidates: result.error.candidates,
    });
  }
  applyCanonical(req, res, result, 'proposal');
  return res.json(result);
});

export default router;
