import express from 'express';
import { publicGetLimiter } from '../../../helper/rateLimiters.js';

const router = express.Router();

router.use(publicGetLimiter);

router.get('/', (req, res) => {
  res.json({
    version: 'v1',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

export default router;
