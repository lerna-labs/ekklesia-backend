// Integrator-facing results surface. Same data and shape as
// /api/v1/results — API-key gated so usage is tracked per integrator
// and per-key rate limits apply.

import { Router } from 'express';
import { requireApiKey, requireScope } from '../../../../helper/apiKeyAuth.js';
import { publicApiLimiter } from '../../../../helper/rateLimiters.js';
import { readBallotResults, readProposalResult } from '../../../../helper/resultReaders.js';

const router = Router();

router.use(requireApiKey);
router.use(publicApiLimiter);
router.use(requireScope('read:results'));

router.get('/ballot/:ballotId', async (req, res) => {
  const result = await readBallotResults(req.params.ballotId);
  if (result.error) {
    return res.status(result.error.status).json({ status: 'error', message: result.error.message });
  }
  return res.json(result);
});

router.get('/proposal/:proposalId', async (req, res) => {
  const result = await readProposalResult(req.params.proposalId);
  if (result.error) {
    return res.status(result.error.status).json({ status: 'error', message: result.error.message });
  }
  return res.json(result);
});

export default router;
