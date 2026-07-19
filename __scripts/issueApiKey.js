// Issue a new public-API key for a third-party integrator.
//
// Prints the plain-text secret ONCE at issuance; only the SHA-256 hash is
// stored. Rotate by running the revocation script + re-issuing.
//
// Usage:
//   node __scripts/issueApiKey.js --label "Wallet X" --contact "ops@walletx.io"
//   node __scripts/issueApiKey.js --label "Read-only stats" --scopes read:ballots,read:results
//   node __scripts/issueApiKey.js --label "Limited" --rpm 30

import process from 'process';
import crypto from 'node:crypto';
import { bootstrap, teardown, parseArgs } from './scaffold/common/env.js';
import { ApiKey } from '../schema/ApiKey.js';
import { hashKey } from '../helper/apiKeyAuth.js';

const { flags } = parseArgs();
if (!flags.label) {
  console.error('Missing --label');
  process.exit(1);
}

await bootstrap();

const plain = `ekk_${crypto.randomBytes(24).toString('base64url')}`;
const prefix = plain.slice(0, 10);

const scopes = flags.scopes
  ? flags.scopes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ['read:ballots', 'read:results'];

const rateLimit = flags.rpm ? { windowMs: 60 * 1000, max: parseInt(flags.rpm, 10) } : {};

const doc = await ApiKey.create({
  label: flags.label,
  contact: flags.contact || null,
  keyHash: hashKey(plain),
  keyPrefix: prefix,
  scopes,
  rateLimit,
});

console.log('--- issued API key ---');
console.log(`id:       ${doc._id}`);
console.log(`label:    ${doc.label}`);
console.log(`scopes:   ${scopes.join(', ')}`);
console.log(`prefix:   ${prefix}`);
console.log(`SECRET:   ${plain}`);
console.log('----------------------');
console.log('Copy the SECRET now. Only the hash is stored — it cannot be recovered.');

await teardown();
process.exit(0);
