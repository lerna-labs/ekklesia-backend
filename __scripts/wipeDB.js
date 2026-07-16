// Nuclear option: drop every collection. For local dev only — never run
// in prod. Requires --confirm to execute.
//
// Usage:
//   node __scripts/wipeDB.js --confirm
//   node __scripts/wipeDB.js --confirm --except sessions,faqs
//
// Flags:
//   --confirm          required; without it the script lists what would be
//                      deleted and exits 1
//   --except a,b,c     collection names to preserve (e.g. sessions,faqs)
//                      valid names: ballots, proposals, votes, transactions,
//                      sessions, comments, results, usercaches, faqs,
//                      votepackages, apikeys, users

import process from 'process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { connectToDatabase, disconnectFromDatabase } from '../helper/dbManager.js';
import { loadLocalOverrides } from '../helper/envOverlay.js';
import { Ballot } from '../schema/Ballot.js';
import { Proposal } from '../schema/Proposal.js';
import { Vote } from '../schema/Vote.js';
import { Transaction } from '../schema/Transaction.js';
import { Session } from '../schema/Session.js';
import { Comment } from '../schema/Comment.js';
import { Result } from '../schema/Result.js';
import { UserCache } from '../schema/UserCache.js';
import { FAQ } from '../schema/FAQ.js';
import { VotePackage } from '../schema/VotePackage.js';
import { ApiKey } from '../schema/ApiKey.js';
import { User } from '../schema/User.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envName = process.env.NODE_ENV || 'development';
dotenv.config({ path: join(__dirname, '..', `.env.${envName}`) });
loadLocalOverrides(join(__dirname, '..'));

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
const COLLECTIONS = {
  ballots: Ballot,
  proposals: Proposal,
  votes: Vote,
  transactions: Transaction,
  sessions: Session,
  comments: Comment,
  results: Result,
  usercaches: UserCache,
  faqs: FAQ,
  votepackages: VotePackage,
  apikeys: ApiKey,
  users: User,
};

const excluded = new Set(
  (flags.except || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const targets = Object.keys(COLLECTIONS).filter((k) => !excluded.has(k));

await connectToDatabase();

// Preview — always shown, so --confirm is a deliberate second step.
console.log(`[wipeDB] env: NODE_ENV=${envName}`);
console.log(`[wipeDB] collections to wipe: ${targets.join(', ')}`);
if (excluded.size) console.log(`[wipeDB] preserved           : ${[...excluded].join(', ')}`);

if (!flags.confirm) {
  console.error(
    '\n[wipeDB] DRY-RUN — re-run with --confirm to actually delete. ' +
      'This is destructive and cannot be undone.',
  );
  await disconnectFromDatabase();
  process.exit(1);
}

console.log('[wipeDB] starting wipe in 3 seconds — Ctrl-C to abort…');
await new Promise((r) => setTimeout(r, 3000));

const counts = {};
for (const name of targets) {
  const res = await COLLECTIONS[name].deleteMany({});
  counts[name] = res.deletedCount;
  console.log(`  - ${name.padEnd(14)} removed ${res.deletedCount}`);
}

console.log('[wipeDB] done.');
await disconnectFromDatabase();
process.exit(0);
