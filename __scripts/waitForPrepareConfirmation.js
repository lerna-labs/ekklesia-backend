// Poll Koios for the /prepare tx hash until it appears on-chain, then exit 0.
// Use this between `scaffoldHydraBallot.js` (which submits /prepare) and
// `/start` (which consumes the commit UTxOs created by that tx) so you don't
// race ahead before the chain has seen the UTxOs.
//
// Usage:
//   node __scripts/waitForPrepareConfirmation.js --ballotId <oid>
//   node __scripts/waitForPrepareConfirmation.js --txHash <hex>      # skip Mongo lookup
//   node __scripts/waitForPrepareConfirmation.js --ballotId <oid> --pollSec 10 --timeoutSec 600

import process from 'process';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { loadLocalOverrides } from '../helper/envOverlay.js';
import { connectToDatabase, disconnectFromDatabase } from '../helper/dbManager.js';
import { Ballot } from '../schema/Ballot.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const envName = process.env.NODE_ENV || 'development';
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
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
const pollSec = Number(flags.pollSec || 10);
const timeoutSec = Number(flags.timeoutSec || 600);
const apiUrl = process.env.API_URL;
const apiToken = process.env.API_TOKEN;

if (!apiUrl || !apiToken) {
  console.error(
    'Koios not configured — set API_URL and API_TOKEN in .env.development / .env.local',
  );
  process.exit(1);
}

let txHash = flags.txHash;

if (!txHash) {
  if (!flags.ballotId) {
    console.error('Pass --ballotId <oid> OR --txHash <hex>');
    process.exit(1);
  }
  if (!mongoose.isValidObjectId(flags.ballotId)) {
    console.error(`Invalid ballotId: ${flags.ballotId}`);
    process.exit(1);
  }
  await connectToDatabase();
  const ballot = await Ballot.findById(flags.ballotId).lean();
  if (!ballot) {
    console.error(`Ballot ${flags.ballotId} not found`);
    await disconnectFromDatabase();
    process.exit(1);
  }
  if (!ballot.prepareTxHash) {
    console.error(`Ballot ${ballot.title} has no prepareTxHash — has /prepare been called?`);
    await disconnectFromDatabase();
    process.exit(1);
  }
  txHash = ballot.prepareTxHash;
  console.log(`[wait] ballot ${ballot.title} prepareTxHash=${txHash}`);
  await disconnectFromDatabase();
}

async function queryTx(hash) {
  const res = await fetch(`${apiUrl}/tx_info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ _tx_hashes: [hash] }),
  });
  if (!res.ok) throw new Error(`Koios ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

const deadline = Date.now() + timeoutSec * 1000;
console.log(`[wait] polling Koios every ${pollSec}s (timeout ${timeoutSec}s)…`);

while (Date.now() < deadline) {
  try {
    const info = await queryTx(txHash);
    if (info) {
      console.log(
        `[wait] ✓ confirmed — block ${info.block_height} slot ${info.absolute_slot} epoch ${info.epoch_no}`,
      );
      process.exit(0);
    }
    process.stdout.write('.');
  } catch (err) {
    console.warn(`\n[wait] query error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, pollSec * 1000));
}

console.error(`\n[wait] timed out after ${timeoutSec}s — tx ${txHash} not on-chain yet`);
process.exit(1);
