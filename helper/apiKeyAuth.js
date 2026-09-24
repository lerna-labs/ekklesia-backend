// API-key middleware for the /api/v1/public/* surface.
//
// Expects an `Authorization: Bearer <key>` header or an `x-api-key` header.
// Stored keys are hashed; the plaintext secret is never persisted.
//
// Issued keys are high-entropy random secrets (24 bytes from
// crypto.randomBytes, see __scripts/issueApiKey.js), not user-chosen
// passwords, so recovering a plaintext key from a leaked hash by brute
// force is computationally infeasible regardless of hash speed. What
// matters instead is that the stored hash is keyed: an unkeyed hash lets
// anyone holding a leaked hash and a candidate plaintext confirm the
// match without the server. HMAC-SHA256 with a server-held secret closes
// that off while staying fast, which is the right tradeoff for a
// fixed-length random token rather than a slow password KDF.
//
// Keys issued before this scheme changed were hashed with unkeyed
// SHA-256. verifyApiKey() still accepts those against the legacy hash and
// rewrites the stored hash to the current HMAC scheme on first successful
// use, so existing keys keep working without a bulk migration.

import crypto from 'node:crypto';
import { ApiKey } from '../schema/ApiKey.js';

function hashSecret() {
  const explicit = process.env.API_KEY_HASH_SECRET;
  if (explicit) return explicit;
  const base = process.env.JWT_SECRET;
  if (!base) {
    throw new Error('API_KEY_HASH_SECRET or JWT_SECRET must be set to hash API keys');
  }
  // No dedicated pepper configured: derive one from JWT_SECRET instead of
  // requiring a second secret. Domain-separated (distinct label, distinct
  // HMAC output) so this value is never usable to forge or verify a JWT.
  return crypto.createHmac('sha256', base).update('ekklesia-backend:apiKeyHash:v1').digest();
}

export function hashKey(plain) {
  return crypto.createHmac('sha256', hashSecret()).update(plain, 'utf8').digest('hex');
}

// Pre-HMAC scheme. Verify-only: a legacy match is rehashed immediately, and
// this is never used to hash a newly issued or rotated key.
function legacyHashKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

// Constant-time comparison of two hex-encoded digests. crypto.timingSafeEqual
// throws on a length mismatch rather than returning false, so that case is
// checked first (length alone is not secret here — both inputs are
// fixed-size SHA-256 digests).
export function hashesEqual(hexA, hexB) {
  const bufA = Buffer.from(hexA, 'hex');
  const bufB = Buffer.from(hexB, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve a presented plaintext API key to its enabled ApiKey record.
 *
 * Tries the current HMAC-SHA256 hash first. If no enabled record matches,
 * falls back to the legacy unkeyed SHA-256 hash so keys issued before the
 * HMAC scheme keep working; a legacy match has its stored hash rewritten
 * to the current scheme so it self-migrates rather than needing a bulk
 * migration or key reissue.
 *
 * Returns the matching ApiKey document, or null if the key does not match
 * any enabled record.
 */
export async function verifyApiKey(plain) {
  const currentHash = hashKey(plain);
  let record = await ApiKey.findOne({ keyHash: currentHash, enabled: true });
  if (record && hashesEqual(record.keyHash, currentHash)) {
    return record;
  }

  const legacyHash = legacyHashKey(plain);
  record = await ApiKey.findOne({ keyHash: legacyHash, enabled: true });
  if (record && hashesEqual(record.keyHash, legacyHash)) {
    // Migrate the stored hash before returning, so the record is on the
    // current scheme by the time any caller observes it, rather than
    // racing a fire-and-forget write.
    await ApiKey.updateOne({ _id: record._id }, { $set: { keyHash: currentHash } });
    record.keyHash = currentHash;
    return record;
  }

  return null;
}

function extractKey(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const xkey = req.get('x-api-key');
  if (xkey) return xkey.trim();
  return null;
}

export async function requireApiKey(req, res, next) {
  const plain = extractKey(req);
  if (!plain) {
    return res.status(401).json({
      status: 'error',
      message: 'API key required (Authorization: Bearer <key> or x-api-key header)',
    });
  }
  const record = await verifyApiKey(plain);
  if (!record) {
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }
  if (record.expiresAt && record.expiresAt < new Date()) {
    return res.status(401).json({ status: 'error', message: 'API key expired' });
  }
  // Touch lastUsedAt (best-effort).
  ApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } }).catch(() => null);
  req.apiKey = {
    id: record._id.toString(),
    label: record.label,
    scopes: record.scopes,
    rateLimit: record.rateLimit || {},
    prefix: record.keyPrefix,
  };
  next();
}

export function requireScope(scope) {
  return (req, res, next) => {
    const scopes = req.apiKey?.scopes || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({ status: 'error', message: `Missing scope: ${scope}` });
    }
    next();
  };
}
