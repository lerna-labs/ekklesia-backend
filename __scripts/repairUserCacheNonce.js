// Realign UserCache.nonce with the highest hydra-confirmed VotePackage
// nonce per (userId, ballotId).
//
// Why this exists
// ---------------
// reserveNext() (helper/nonceManager.js) is the only path that writes
// UserCache.nonce on /draft, and it increments from the stored value
// (or null → 0). If something deleted or reset the UserCache row after
// a voter's vote was already confirmed on Hydra, the next /draft starts
// the counter back at 1 — but Hydra is at currentVersion = N, expects
// N+1, and rejects every submission with NONCE_STALE.
//
// The original trigger in production was `revalidateBallotVoters.js
// --force`: it deleted UserCache rows before re-running the validator,
// and the re-validation upsert wrote a fresh row with the schema's
// default `nonce: null`. Every voter on the ballot who had previously
// voted ended up with a poisoned reservation counter.
//
// What this script does
// ---------------------
// For each Hydra ballot (or just the one passed via --ballot):
//   1. Aggregate max(VotePackage.nonce) where status == "hydra-confirmed",
//      grouped by userId.
//   2. For each (userId, ballotId, maxNonce), update UserCache via $max
//      so the stored counter is at least maxNonce. Never decrements.
//      Upserts when no UserCache row exists yet (rare — would mean the
//      validator never wrote one).
//   3. Reports what would change (or, with --apply, what did).
//
// Idempotent. Safe to re-run. After this, reserveNext() will return
// the correct value (maxNonce + 1) for the voter's next /draft.
//
// Usage
// -----
//   node __scripts/repairUserCacheNonce.js                        # dry-run, every Hydra ballot
//   node __scripts/repairUserCacheNonce.js --ballot <id>          # dry-run, one ballot
//   node __scripts/repairUserCacheNonce.js --apply                # write
//   node __scripts/repairUserCacheNonce.js --ballot <id> --apply  # write, one ballot
//
// Exit codes:
//   0 — completed (dry-run or apply)
//   1 — bad args / ballot not found / DB connect failed

import process from 'process';
import mongoose from 'mongoose';
import { bootstrap, teardown, parseArgs } from './scaffold/common/env.js';
import { Ballot } from '../schema/Ballot.js';
import { UserCache } from '../schema/UserCache.js';
import { VotePackage } from '../schema/VotePackage.js';

const { flags } = parseArgs();
const apply = Boolean(flags.apply);
const ballotIdArg = flags.ballot || null;

if (ballotIdArg && !mongoose.isValidObjectId(ballotIdArg)) {
  console.error(`[repair] invalid ballot id: ${ballotIdArg}`);
  process.exit(1);
}

await bootstrap();

const ballotFilter = { source: 'hydra' };
if (ballotIdArg) ballotFilter._id = new mongoose.Types.ObjectId(ballotIdArg);

const ballots = await Ballot.find(ballotFilter)
  .select('_id title status source')
  .sort({ createdAt: 1 })
  .lean();

if (ballots.length === 0) {
  console.log(
    ballotIdArg
      ? `[repair] no Hydra ballot matches ${ballotIdArg}`
      : '[repair] no Hydra ballots found',
  );
  await teardown();
  process.exit(ballotIdArg ? 1 : 0);
}

console.log(`[repair] scanning ${ballots.length} ballot(s)${apply ? '' : ' — DRY RUN'}`);

const grandTotals = { voters: 0, repaired: 0, alreadyAligned: 0, missingRow: 0 };

for (const ballot of ballots) {
  // max(nonce) per voter for confirmed packages on this ballot.
  const maxByVoter = await VotePackage.aggregate([
    {
      $match: {
        ballotId: ballot._id,
        status: 'hydra-confirmed',
        nonce: { $type: 'number' },
      },
    },
    { $group: { _id: '$userId', maxNonce: { $max: '$nonce' } } },
  ]);

  if (maxByVoter.length === 0) {
    console.log(
      `[repair] ${ballot._id} "${ballot.title}" (${ballot.status}): no confirmed packages — skipping`,
    );
    continue;
  }

  const tallies = { voters: maxByVoter.length, repaired: 0, alreadyAligned: 0, missingRow: 0 };
  const repairs = [];

  for (const { _id: userId, maxNonce } of maxByVoter) {
    const cache = await UserCache.findOne({ ballotId: ballot._id, userId }).select('nonce').lean();

    const cacheNonce = cache?.nonce ?? null;
    if (cache && typeof cacheNonce === 'number' && cacheNonce >= maxNonce) {
      tallies.alreadyAligned++;
      continue;
    }

    if (!cache) tallies.missingRow++;
    tallies.repaired++;
    repairs.push({ userId, from: cacheNonce, to: maxNonce, hadRow: !!cache });
  }

  console.log(
    `[repair] ${ballot._id} "${ballot.title}" (${ballot.status}): ` +
      `voters=${tallies.voters} aligned=${tallies.alreadyAligned} ` +
      `needsRepair=${tallies.repaired} (missingRow=${tallies.missingRow})`,
  );

  // Always print a small preview so dry-runs are useful.
  const preview = repairs.slice(0, 10);
  for (const r of preview) {
    console.log(
      `  ${r.userId}: ${r.from === null ? 'null' : r.from} → ${r.to}${r.hadRow ? '' : ' (creates row)'}`,
    );
  }
  if (repairs.length > preview.length) {
    console.log(`  … +${repairs.length - preview.length} more`);
  }

  if (apply && repairs.length > 0) {
    for (const r of repairs) {
      // $max preserves the higher of stored vs maxNonce — defensive
      // against a concurrent reserveNext that already advanced the
      // counter between our read and this write.
      await UserCache.updateOne(
        { ballotId: ballot._id, userId: r.userId },
        { $max: { nonce: r.to } },
        { upsert: true },
      );
    }
    console.log(`[repair] ${ballot._id} wrote ${repairs.length} repair(s)`);
  }

  grandTotals.voters += tallies.voters;
  grandTotals.repaired += tallies.repaired;
  grandTotals.alreadyAligned += tallies.alreadyAligned;
  grandTotals.missingRow += tallies.missingRow;
}

console.log(
  `\n[repair] totals: voters=${grandTotals.voters} ` +
    `aligned=${grandTotals.alreadyAligned} repaired=${grandTotals.repaired} ` +
    `(missingRow=${grandTotals.missingRow})`,
);
if (!apply) {
  console.log('[repair] dry-run — re-run with --apply to write');
}

await teardown();
process.exit(0);
