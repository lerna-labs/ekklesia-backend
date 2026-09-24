/**
 * Integration test for the API-key hashing/verification scheme.
 * Requires MongoDB. Same URI resolution as aggregateVotes.grouped.test.js.
 * Skipped automatically when no URI can be resolved.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.development') });

// verifyApiKey/hashKey read process.env.API_KEY_HASH_SECRET (falling back to
// JWT_SECRET) at call time, not at import time, so setting it here is
// sufficient even though it happens after other modules may already be
// loaded.
process.env.API_KEY_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'test-api-key-hash-secret';

function getMongoUri() {
  if (process.env.MONGODB_URI_TEST || process.env.MONGODB_URI) {
    return process.env.MONGODB_URI_TEST || process.env.MONGODB_URI;
  }
  const database = process.env.MONGODB_DATABASE;
  if (!database) return null;
  const host = process.env.MONGODB_HOST || 'localhost';
  const port = process.env.MONGODB_PORT || '27017';
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const authSource = process.env.MONGODB_AUTH_SOURCE || 'admin';
  const dbName = process.env.MONGODB_DATABASE_TEST || `${database}_test`;
  let uri = 'mongodb://';
  if (username && password) {
    uri += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  uri += `${host}:${port}/${dbName}`;
  if (username && password) uri += `?authSource=${authSource}`;
  return uri;
}

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiKey } from '../../schema/ApiKey.js';
import { hashKey, hashesEqual, verifyApiKey } from '../apiKeyAuth.js';

const mongoUri = getMongoUri();
const describeFn = mongoUri ? describe : describe.skip;

const LABEL_PREFIX = 'apiKeyAuth-test-';

function legacySha256(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

async function cleanup() {
  await ApiKey.deleteMany({ label: { $regex: `^${LABEL_PREFIX}` } });
}

describeFn('apiKeyAuth (mongo)', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  afterEach(async () => {
    await cleanup();
  });

  test('verifies a key stored with the current HMAC scheme, without rewriting it', async () => {
    const plain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    const stored = hashKey(plain);
    const doc = await ApiKey.create({
      label: `${LABEL_PREFIX}current`,
      keyHash: stored,
      keyPrefix: plain.slice(0, 10),
    });

    const record = await verifyApiKey(plain);
    expect(record).not.toBeNull();
    expect(record._id.toString()).toBe(doc._id.toString());

    const reloaded = await ApiKey.findById(doc._id);
    expect(reloaded.keyHash).toBe(stored);
  });

  test('verifies a key stored with the legacy unkeyed SHA-256 scheme', async () => {
    const plain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    const legacyHash = legacySha256(plain);
    const doc = await ApiKey.create({
      label: `${LABEL_PREFIX}legacy`,
      keyHash: legacyHash,
      keyPrefix: plain.slice(0, 10),
    });

    const record = await verifyApiKey(plain);
    expect(record).not.toBeNull();
    expect(record._id.toString()).toBe(doc._id.toString());
  });

  test('rewrites a legacy hash to the current scheme on successful use', async () => {
    const plain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    const legacyHash = legacySha256(plain);
    const doc = await ApiKey.create({
      label: `${LABEL_PREFIX}rehash`,
      keyHash: legacyHash,
      keyPrefix: plain.slice(0, 10),
    });

    const record = await verifyApiKey(plain);
    expect(record).not.toBeNull();

    const reloaded = await ApiKey.findById(doc._id);
    expect(reloaded.keyHash).not.toBe(legacyHash);
    expect(reloaded.keyHash).toBe(hashKey(plain));

    // The now-current hash verifies too, and no longer needs the legacy path.
    const secondRecord = await verifyApiKey(plain);
    expect(secondRecord).not.toBeNull();
    expect(secondRecord._id.toString()).toBe(doc._id.toString());
  });

  test('rejects a key that does not match any stored hash (current or legacy)', async () => {
    const rightPlain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    const wrongPlain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    await ApiKey.create({
      label: `${LABEL_PREFIX}wrong-current`,
      keyHash: hashKey(rightPlain),
      keyPrefix: rightPlain.slice(0, 10),
    });
    await ApiKey.create({
      label: `${LABEL_PREFIX}wrong-legacy`,
      keyHash: legacySha256(rightPlain),
      keyPrefix: rightPlain.slice(0, 10),
    });

    const record = await verifyApiKey(wrongPlain);
    expect(record).toBeNull();
  });

  test('does not match a disabled record', async () => {
    const plain = `ekk_${crypto.randomBytes(16).toString('base64url')}`;
    await ApiKey.create({
      label: `${LABEL_PREFIX}disabled`,
      keyHash: hashKey(plain),
      keyPrefix: plain.slice(0, 10),
      enabled: false,
    });

    const record = await verifyApiKey(plain);
    expect(record).toBeNull();
  });
});

describe('hashKey / hashesEqual (no mongo required)', () => {
  beforeAll(() => {
    process.env.API_KEY_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'test-api-key-hash-secret';
  });

  test('hashKey is deterministic for the same plaintext', () => {
    const plain = 'ekk_sample-key-value';
    expect(hashKey(plain)).toBe(hashKey(plain));
  });

  test('hashKey differs from the legacy unkeyed SHA-256 digest', () => {
    const plain = 'ekk_sample-key-value';
    expect(hashKey(plain)).not.toBe(legacySha256(plain));
  });

  test('hashKey changes when the secret changes', () => {
    const plain = 'ekk_sample-key-value';
    const withFirstSecret = hashKey(plain);

    const previous = process.env.API_KEY_HASH_SECRET;
    process.env.API_KEY_HASH_SECRET = 'a-different-secret';
    try {
      expect(hashKey(plain)).not.toBe(withFirstSecret);
    } finally {
      process.env.API_KEY_HASH_SECRET = previous;
    }
  });

  test('hashesEqual matches equal digests in constant time and rejects a mismatch', () => {
    const a = hashKey('ekk_one');
    const b = hashKey('ekk_one');
    const c = hashKey('ekk_two');
    expect(hashesEqual(a, b)).toBe(true);
    expect(hashesEqual(a, c)).toBe(false);
  });

  test('hashesEqual rejects a length mismatch instead of throwing', () => {
    expect(hashesEqual('ab'.repeat(32), 'ab'.repeat(16))).toBe(false);
  });
});
