// Migrate Result rows from the legacy `source: "final"` label to the
// new `source: "provisional"` semantics.
//
// Context: pre-authority-certification the backend labeled the Hydra-
// finalized tally as "final", conflating "the head's cryptographic
// proof is complete" with "the voting-authority's certified result."
// The new model (see `.claude/plans/jolly-copper-blakely.md`) reserves
// `source: "certified"` for authority publications and uses
// `source: "provisional"` for every state before that — including the
// Hydra-finalized-but-not-certified state. Legacy rows get flipped
// here, and their existing `finalizedAt` is mirrored to the new
// `hydraFinalizedAt` field so the "Hydra finalized at" timestamp
// survives the rename.
//
// Idempotent: running twice is a no-op after the first pass.
//
// Usage:
//   node __scripts/migrateFinalToProvisional.js          # dry-run (count only)
//   node __scripts/migrateFinalToProvisional.js --apply  # write

import process from 'process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { loadLocalOverrides } from '../helper/envOverlay.js';
import { connectToDatabase, disconnectFromDatabase } from '../helper/dbManager.js';
import { Result } from '../schema/Result.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const envName = process.env.NODE_ENV || 'development';
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const apply = process.argv.includes('--apply');

await connectToDatabase();
try {
  const candidates = await Result.find({ source: 'final' })
    .select('_id source finalizedAt hydraFinalizedAt updatedAt')
    .lean();
  console.log(`[migrate] candidates (source: "final"): ${candidates.length}`);
  if (candidates.length === 0) {
    console.log('[migrate] nothing to do');
  } else if (!apply) {
    console.log('[migrate] dry-run — re-run with --apply to write');
  } else {
    let updated = 0;
    for (const row of candidates) {
      const hydraFinalizedAt =
        row.hydraFinalizedAt || row.finalizedAt || row.updatedAt || new Date();
      await Result.updateOne(
        { _id: row._id },
        { $set: { source: 'provisional', hydraFinalizedAt } },
      );
      updated += 1;
    }
    console.log(`[migrate] updated ${updated} rows`);
  }
} finally {
  await disconnectFromDatabase();
}
