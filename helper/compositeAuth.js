// Composite auth: admin JWT OR API key with a required scope.
//
// Used where a single endpoint serves two operator paths — e.g. the
// ballot import endpoint, which accepts both a proposals-module push
// (API key with `write:ballot-import`) and an admin upload (JWT).
//
// Fast path: if a cookie token is present and maps to an admin, we
// proceed without touching the database at all. Otherwise fall back
// to the API-key check (which hits Mongo once).

import { verifyToken } from './verifyToken.js';
import { userIsAdmin } from './adminAuth.js';
import { hashKey } from './apiKeyAuth.js';
import { ApiKey } from '../schema/ApiKey.js';

function extractKey(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const x = req.get('x-api-key');
  if (x) return x.trim();
  return null;
}

/**
 * @param {string} scope — required scope on the API key if the request
 *                          is authenticated via API key (ignored for
 *                          admin JWTs).
 */
export function adminOrScope(scope) {
  return async (req, res, next) => {
    // 1. Admin JWT path.
    const token = verifyToken(req);
    if (token.status === 'success' && userIsAdmin({ userId: token.userId, role: token.role })) {
      req.auth = { kind: 'admin', userId: token.userId };
      return next();
    }

    // 2. API-key path.
    const plain = extractKey(req);
    if (plain) {
      try {
        const record = await ApiKey.findOne({ keyHash: hashKey(plain), enabled: true });
        if (!record) {
          return res.status(401).json({ status: 'error', message: 'Invalid API key' });
        }
        if (record.expiresAt && record.expiresAt < new Date()) {
          return res.status(401).json({ status: 'error', message: 'API key expired' });
        }
        if (!record.scopes?.includes(scope)) {
          return res.status(403).json({ status: 'error', message: `Missing scope: ${scope}` });
        }
        ApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } }).catch(
          () => null,
        );
        req.auth = {
          kind: 'apiKey',
          id: record._id.toString(),
          label: record.label,
          prefix: record.keyPrefix,
          scopes: record.scopes,
        };
        req.apiKey = req.auth;
        return next();
      } catch (err) {
        console.error('compositeAuth: API key lookup failed', err);
        return res.status(500).json({ status: 'error', message: 'Auth lookup failed' });
      }
    }

    // Neither path succeeded.
    return res.status(401).json({
      status: 'error',
      message: 'Admin session or API key required (Authorization: Bearer <key> or x-api-key)',
    });
  };
}
