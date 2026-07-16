// Deterministic voter seeder.
//
// Idempotent: creates or upserts a User per fixture; if --ballotId is passed,
// also upserts a UserCache row pinning validated/votingPower/voterGroup for
// that ballot. Safe to re-run.
//
// Usage:
//   node __scripts/scaffold/seedVoters.js
//   node __scripts/scaffold/seedVoters.js --ballotId 65f0...

import process from 'process';
import { bootstrap, teardown, parseArgs } from './common/env.js';
import { VOTERS } from './common/fixtures.js';
import { User } from '../../schema/User.js';
import { UserCache } from '../../schema/UserCache.js';

const { flags } = parseArgs();

await bootstrap();

for (const v of VOTERS) {
  await User.updateOne(
    { _id: v.userId },
    { $set: { name: v.name, lastLogin: new Date() } },
    { upsert: true },
  );
  console.log(`[user] ${v.userId}`);

  if (flags.ballotId) {
    await UserCache.updateOne(
      { ballotId: flags.ballotId, userId: v.userId },
      {
        $set: {
          validated: v.validated,
          votingPower: v.votingPower,
          voterGroup: v.voterGroup,
        },
      },
      { upsert: true },
    );
    console.log(`  [cache] ballot=${flags.ballotId} power=${v.votingPower}`);
  }
}

console.log(`[seedVoters] ${VOTERS.length} voters ready`);
await teardown();
process.exit(0);
