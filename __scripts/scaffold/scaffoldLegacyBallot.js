// Scaffold a single legacy-shaped ballot (idempotent).
//
// Legacy is the archive surface in this codebase — writes to v0 ballots
// are frozen, and live/upcoming legacy ballots don't represent anything
// real. This script only produces `closed` legacy rows; pass
// source:"hydra" to scaffoldHydraBallot.js for upcoming/live.
//
// Usage:
//   node __scripts/scaffold/scaffoldLegacyBallot.js --flavor dreps
//   node __scripts/scaffold/scaffoldLegacyBallot.js --flavor poolStake --index 2
//
// Flags:
//   --flavor   any key from VALIDATION_SCRIPTS (default: dreps)
//   --index    integer disambiguator baked into the deterministic title (default: 1)
//   --state    deprecated — always forced to "closed"

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { upsertScaffoldBallot } from "./common/ballotFactory.js";

const { flags } = parseArgs();
const flavor = flags.flavor || "dreps";
const index = flags.index ? parseInt(flags.index, 10) : 1;

if (flags.state && flags.state !== "closed") {
  console.warn(
    `[scaffoldLegacyBallot] --state=${flags.state} ignored; legacy ballots are archive-only (closed).`
  );
}

await bootstrap();

const ballot = await upsertScaffoldBallot({
  source: "legacy",
  state: "closed",
  flavor,
  index,
});

console.log(`[scaffoldLegacyBallot] ${ballot.title} (${ballot._id})`);

await teardown();
process.exit(0);
