// Scaffold a single legacy-shaped ballot (idempotent).
//
// Usage:
//   node __scripts/scaffold/scaffoldLegacyBallot.js --flavor dreps --state live
//   node __scripts/scaffold/scaffoldLegacyBallot.js --flavor poolStake --state closed --index 2
//
// Flags:
//   --flavor   dreps | stake | poolPledge | poolStake | alwaysTrue  (default: dreps)
//   --state    upcoming | live | closed                             (default: live)
//   --index    integer disambiguator baked into the deterministic title (default: 1)

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { upsertScaffoldBallot } from "./common/ballotFactory.js";

const { flags } = parseArgs();
const flavor = flags.flavor || "dreps";
const state = flags.state || "live";
const index = flags.index ? parseInt(flags.index, 10) : 1;

await bootstrap();

const ballot = await upsertScaffoldBallot({
  source: "legacy",
  state,
  flavor,
  index,
});

console.log(`[scaffoldLegacyBallot] ${ballot.title} (${ballot._id})`);

await teardown();
process.exit(0);
