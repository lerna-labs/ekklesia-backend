// API-key middleware for the /api/v1/public/* surface.
//
// Expects an `Authorization: Bearer <key>` header or an `x-api-key` header.
// Stored keys are SHA-256 hashed; the plaintext secret is never persisted.

import crypto from 'node:crypto';
import { ApiKey } from '../schema/ApiKey.js';

export function hashKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
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
  const keyHash = hashKey(plain);
  const record = await ApiKey.findOne({ keyHash, enabled: true });
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
