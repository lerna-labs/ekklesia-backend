// Drop existing Result docs + refresh Vote.submittedAt timestamps so
// the next aggregation cron pass rebuilds tallies from scratch using
// the current rollup logic (ballotParticipation, proposalParticipation,
// scale stats, ranked distribution, etc.).
//
// Why this is needed: the cron processes only proposals whose votes
// landed in the last 12 minutes (`Vote.submittedAt >= now - 12min`)
// AND skips proposals whose Result is already `source: "final"`. Our
// scaffolded data spreads submittedAt across days and stamps closed
// ballots as final, so the cron would otherwise skip them.
//
// Optionally invokes aggregateVotes() in-process so you don't have to
// wait for the next 10-minute tick.
//
// Usage:
//   node __scripts/refreshScaffoldResults.js
//   node __scripts/refreshScaffoldResults.js --no-aggregate   (just touch the data, let cron run)
//   node __scripts/refreshScaffoldResults.js --titles-prefix "Scaffold/"  (default; restrict to scaffold-titled ballots)
//   node __scripts/refreshScaffoldResults.js --all  (touch everything; use carefully)

import process from 'process';
import { bootstrap, teardown, parseArgs } from './scaffold/common/env.js';
import { Ballot } from '../schema/Ballot.js';
import { Vote } from '../schema/Vote.js';
import { Result } from '../schema/Result.js';
import { aggregateVotes } from '../crons/10minAggregateVotes.js';

const { flags } = parseArgs();
const skipAggregate = Boolean(flags['no-aggregate']);
const touchAll = Boolean(flags.all);
const titlesPrefix = flags['titles-prefix'] || 'Scaffold/';

await bootstrap();

const ballotFilter = touchAll
  ? {}
  : { title: { $regex: `^${titlesPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } };
const ballots = await Ballot.find(ballotFilter).select('_id title status').lean();
console.log(
  `[refresh] matched ${ballots.length} ballot(s)${touchAll ? ' (--all)' : ` with title prefix "${titlesPrefix}"`}`,
);
if (ballots.length === 0) {
  await teardown();
  process.exit(0);
}

const ballotIds = ballots.map((b) => b._id);

// 1. Drop existing Result docs for matched ballots (cron skips final).
const dropped = await Result.deleteMany({ ballotId: { $in: ballotIds } });
console.log(`[refresh] dropped ${dropped.deletedCount} Result doc(s)`);

// 2. Refresh Vote.submittedAt for matched ballots so the cron's
//    12-min lookback catches them. Spread within the last 5 minutes
//    so they look like organic recent activity.
const now = Date.now();
const FIVE_MIN = 5 * 60 * 1000;
const voteCursor = Vote.find({
  ballotId: { $in: ballotIds },
  submittedAt: { $ne: null },
})
  .select('_id')
  .cursor();
let touched = 0;
for await (const v of voteCursor) {
  const offset = Math.floor(Math.random() * FIVE_MIN);
  await Vote.updateOne({ _id: v._id }, { $set: { submittedAt: new Date(now - offset) } });
  touched++;
}
console.log(`[refresh] re-stamped submittedAt on ${touched} Vote(s)`);

// 3. Optionally run aggregation in-process.
if (skipAggregate) {
  console.log('[refresh] --no-aggregate — leaving cron to run on its own');
} else {
  console.log('[refresh] running aggregateVotes()...');
  await aggregateVotes();
  console.log('[refresh] aggregation complete');

  // 4. Re-stamp source: "final" + finalizedAt on results belonging to
  //    closed ballots. The cron always writes "provisional" since it's
  //    designed for incremental tallying during the voting window;
  //    closed scaffold ballots represent ARCHIVED results and need
  //    the "final" flag back.
  const closedIds = ballots.filter((b) => b.status === 'closed').map((b) => b._id);
  if (closedIds.length > 0) {
    const r = await Result.updateMany(
      { ballotId: { $in: closedIds } },
      { $set: { source: 'final', finalizedAt: new Date() } },
    );
    console.log(`[refresh] re-stamped ${r.modifiedCount} closed-ballot Result(s) as final`);
  }
}

await teardown();
process.exit(0);
