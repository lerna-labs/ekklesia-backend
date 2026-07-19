// Dev-only: mint a JWT signed with JWT_SECRET from .env.development
// (and .env.local overlay). Matches the payload shape that routes/api/v0/
// session.js produces so the token works as a `token` cookie for any
// endpoint that calls verifyToken().
//
// DO NOT use in production. This bypasses the signature-based login flow.
//
// Usage:
//   node __scripts/mintDevJwt.js --userId drep1...
//   node __scripts/mintDevJwt.js --userId drep1... --admin
//   node __scripts/mintDevJwt.js --userId drep1... --multisig --ttl 1h
//
// Output:
//   token:      <jwt>
//   cookie:     token=<jwt>
//   curl flag:  --cookie token=<jwt>

import process from 'process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { loadLocalOverrides } from '../helper/envOverlay.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: join(repoRoot, `.env.${env}`) });
loadLocalOverrides(repoRoot);

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    if (body.includes('=')) {
      const [k, ...rest] = body.split('=');
      flags[k] = rest.join('=');
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[++i];
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

const flags = parseArgs();
const userId = flags.userId || flags.user;
if (!userId) {
  console.error('Missing --userId <bech32 id>');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET not set — check .env.development / .env.local');
  process.exit(1);
}

const payload = {
  userId,
  signType: flags.signType || 'stake',
  multiSig: Boolean(flags.multisig || flags.multiSig),
};
if (flags.admin) payload.role = 'admin';

const ttl = flags.ttl || process.env.JWT_MAX_AGE || '1h';
const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ttl });

console.log('payload:   ' + JSON.stringify(payload));
console.log('ttl:       ' + ttl);
console.log('token:     ' + token);
console.log('cookie:    token=' + token);
console.log('curl flag: --cookie token=' + token);
console.log('');
console.log('# paste this line into your shell:');
console.log(`export JWT_COOKIE='token=${token}'`);

const adminIds = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (flags.admin && !payload.role) {
  // Shouldn't happen — kept for clarity
  console.warn('Note: --admin did not stamp role claim.');
}
if (!flags.admin && adminIds.includes(userId)) {
  console.log(
    'note:      userId is on ADMIN_USER_IDS allowlist (admin gate will pass without --admin)',
  );
} else if (flags.admin) {
  console.log('note:      role="admin" claim stamped (admin gate will pass)');
} else {
  console.log('note:      plain-voter token; admin routes will return 403');
}
