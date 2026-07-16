// Call Hydra's POST /sweep to consolidate the admin wallet:
//   - moves any residue native tokens to HYDRA_SWEEP_ADDRESS (or --dumpAddress)
//   - merges fragmented ADA UTxOs into a single output
//
// Useful between test runs or after a failed /prepare left stale tokens
// behind. /sweep is a real tx — not idempotent — so only run when the wallet
// actually needs cleanup.
//
// Usage:
//   node __scripts/sweepAdminWallet.js                        # uses HYDRA_SWEEP_ADDRESS
//   node __scripts/sweepAdminWallet.js --dumpAddress addr_test1...
//   node __scripts/sweepAdminWallet.js --endpoint https://hydra.preprod.example --dumpAddress addr_test1...

import process from 'process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { loadLocalOverrides } from '../helper/envOverlay.js';
import { forEndpoint, HydraClientError } from '../helper/hydraClient.js';

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
const endpoint = flags.endpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
const dumpAddress = flags.dumpAddress || process.env.HYDRA_SWEEP_ADDRESS;

if (!endpoint) {
  console.error('No Hydra endpoint — set HYDRA_DEFAULT_ENDPOINT or pass --endpoint');
  process.exit(1);
}
if (!dumpAddress) {
  console.error('No dump address — set HYDRA_SWEEP_ADDRESS in .env.local or pass --dumpAddress');
  process.exit(1);
}

console.log(`[sweep] endpoint    = ${endpoint}`);
console.log(`[sweep] dumpAddress = ${dumpAddress}`);

try {
  const client = forEndpoint(endpoint);
  const data = await client.sweep({ dumpAddress });
  console.log('[sweep] result:', JSON.stringify(data, null, 2));
} catch (err) {
  if (err instanceof HydraClientError) {
    console.error(`[sweep] Hydra /sweep failed: ${err.message}`);
    if (err.data) console.error('  upstream:', JSON.stringify(err.data));
  } else {
    console.error(`[sweep] unexpected error: ${err.stack || err.message}`);
  }
  process.exit(1);
}

process.exit(0);
