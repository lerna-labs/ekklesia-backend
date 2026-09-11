// Admin gate. A userId is an admin if and only if it appears in the
// ADMIN_USER_IDS env (comma-separated bech32 ids). There is no other
// mechanism: an earlier JWT `role === "admin"` claim was never wired up
// (verifyToken.js has never returned a role field from the decoded
// token) and has been removed rather than implemented, since nothing
// mints that claim and nothing documents it as intended.

import { verifyToken } from './verifyToken.js';

function adminIdSet() {
  const raw = process.env.ADMIN_USER_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Pure check — is this userId on the ADMIN_USER_IDS allowlist?
 * Used by session reads that need to tell the frontend whether to show
 * admin UI. The middleware below wraps this for route gating.
 */
export function userIsAdmin({ userId } = {}) {
  return adminIdSet().has(userId);
}

export function isAdmin(req, res, next) {
  const result = verifyToken(req);
  if (result.status !== 'success') {
    return res.status(result.code || 401).json({ status: 'error', message: result.message });
  }
  if (!userIsAdmin({ userId: result.userId })) {
    return res.status(403).json({ status: 'error', message: 'Admin privileges required' });
  }
  req.auth = { userId: result.userId, role: 'admin-allowlist' };
  next();
}
