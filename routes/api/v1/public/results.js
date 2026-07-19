// Integrator-facing results surface. Same data and shape as
// /api/v1/results — API-key gated so usage is tracked per integrator
// and per-key rate limits apply.

import { Router } from 'express';
import { requireApiKey, requireScope } from '../../../../helper/apiKeyAuth.js';
import { publicApiLimiter } from '../../../../helper/rateLimiters.js';
import { readBallotResults, readProposalResult } from '../../../../helper/resultReaders.js';
import { canonicalApiPath, setCanonicalLinkHeader } from '../../../../helper/idResolver.js';

const router = Router();

router.use(requireApiKey);
router.use(publicApiLimiter);
router.use(requireScope('read:results'));

// Mirrors /api/v1/results — emits the canonical `_id` path when the
// caller addressed the row by its upstream external id.
function applyCanonical(res, result, kind) {
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
  applyCanonical(res, result, 'ballot');
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
  applyCanonical(res, result, 'proposal');
  return res.json(result);
});

export default router;
