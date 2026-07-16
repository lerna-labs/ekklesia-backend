// GET /api/v1/admin/me — authenticated probe for admin status.
//
// Replaces the `isAdmin: bool` flag that used to ride on every
// GET /api/v0/session response. Frontends call this endpoint only on
// routes that actually need to gate admin UI; a leaked or forged voter
// JWT can't be used to enumerate which userIds carry admin rights
// because the answer is "not found" for everyone except actual admins.

import { Router } from 'express';
import { verifyToken } from '../../../../helper/verifyToken.js';
import { userIsAdmin } from '../../../../helper/adminAuth.js';

const router = Router();

router.get('/', (req, res) => {
  const result = verifyToken(req);
  if (result.status !== 'success') {
    return res.status(result.code || 401).json({ status: 'error', message: result.message });
  }
  if (!userIsAdmin({ userId: result.userId, role: result.role })) {
    // 404 (not 403) so an attacker can't differentiate "no admin row
    // for this userId" from "admin endpoints don't exist here".
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }
  return res.status(200).json({
    status: 'success',
    data: {
      userId: result.userId,
      isAdmin: true,
    },
  });
});

export default router;
