// Public ballot listing for third-party integrators. Read-only, API-key
// gated, rate-limited. Same data shape as /api/v1/ballots (unified across
// sources); kept on a separate router so we can tighten access policies
// independently.

import { Router } from 'express';
import validator from 'validator';
import mongoose from 'mongoose';
import { listUnified, getUnified } from '../../../../helper/ballotAdapters/index.js';
import { requireApiKey, requireScope } from '../../../../helper/apiKeyAuth.js';
import { publicApiLimiter } from '../../../../helper/rateLimiters.js';
import { escapeRegex } from '../../../../helper/escapeRegex.js';
import { canonicalApiPath, setCanonicalLinkHeader } from '../../../../helper/idResolver.js';

const router = Router();

router.use(requireApiKey);
router.use(publicApiLimiter);
router.use(requireScope('read:ballots'));

router.get('/', async (req, res) => {
  const { voterType, status, search, page = 1, limit = 10, source } = req.query;
  const filter = {};

  if (search) {
    if (!validator.isLength(search, { min: 1, max: 100 })) {
      return res.status(400).json({ status: 'error', message: 'search 1-100 chars' });
    }
    if (['$', '{', '}'].some((c) => search.includes(c))) {
      return res
        .status(400)
        .json({ status: 'error', message: 'search contains invalid characters' });
    }
    // String-form $regex with escaped metachars; avoids the
    // `new RegExp(user_input)` SyntaxError reflection path.
    filter.$or = [{ title: { $regex: escapeRegex(search), $options: 'i' } }];
    if (validator.isMongoId(search)) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(search) });
    }
  }
  if (voterType) {
    if (!validator.isAlphanumeric(voterType)) {
      return res.status(400).json({ status: 'error', message: 'invalid voterType' });
    }
    filter.voterType = { $regex: `^${escapeRegex(voterType)}$`, $options: 'i' };
  }
  if (status) {
    if (!['live', 'closed', 'upcoming'].includes(status.toLowerCase())) {
      return res.status(400).json({ status: 'error', message: 'invalid status' });
    }
    filter.status = status.toLowerCase();
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  if (isNaN(pageNum) || pageNum < 1)
    return res.status(400).json({ status: 'error', message: 'invalid page' });
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({ status: 'error', message: 'invalid limit (1-100)' });
  }
  if (source && !['legacy', 'hydra'].includes(source)) {
    return res.status(400).json({ status: 'error', message: 'invalid source' });
  }

  try {
    const result = await listUnified({ filter, page: pageNum, limit: limitNum, source });
    return res.json({ data: result.items, pagination: result.pagination });
  } catch (err) {
    console.error('[public/ballots] error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await getUnified(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    if (doc.__ambiguous) {
      return res.status(409).json({
        status: 'error',
        code: 'ID_COLLISION',
        message: 'External ballot id matches multiple ballots; use the canonical _id',
        candidates: doc.__ambiguous,
      });
    }
    const payload = { data: doc };
    if (doc.id && doc.id !== req.params.id) {
      payload.canonical = canonicalApiPath('ballot', doc.id);
      setCanonicalLinkHeader(res, payload.canonical);
    }
    return res.json(payload);
  } catch (err) {
    console.error('[public/ballots/:id] error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

export default router;
