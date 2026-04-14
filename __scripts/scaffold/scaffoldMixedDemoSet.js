// Seed a realistic mixed-source demo set: N legacy + M Hydra ballots across
// upcoming/live/closed states, plus the deterministic voter cohort.
//
// Idempotent at the Ballot/User/UserCache level. Hydra /prepare calls are
// only attempted for ballots that haven't already been prepared.
//
// Usage:
//   node __scripts/scaffold/scaffoldMixedDemoSet.js
//   node __scripts/scaffold/scaffoldMixedDemoSet.js --endpoint https://hydra.preprod.example
//   node __scripts/scaffold/scaffoldMixedDemoSet.js --skip-hydra

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { upsertScaffoldBallot } from "./common/ballotFactory.js";
import { buildPrepareBody } from "./common/hydraPrepare.js";
import { VOTERS } from "./common/fixtures.js";
import { User } from "../../schema/User.js";
import { UserCache } from "../../schema/UserCache.js";
import { forEndpoint, HydraClientError } from "../../helper/hydraClient.js";

const { flags } = parseArgs();

const LEGACY_PLAN = [
  { flavor: "dreps", state: "closed", index: 1 },
  { flavor: "dreps", state: "live", index: 1 },
  { flavor: "poolPledge", state: "upcoming", index: 1 },
];
const HYDRA_PLAN = [
  { flavor: "dreps", state: "live", index: 1 },
  { flavor: "stake", state: "upcoming", index: 1 },
];

// bootstrap() loads .env.development + .env.local, so read HYDRA_DEFAULT_ENDPOINT
// AFTER bootstrap completes — reading before would miss env-file values.
await bootstrap();

const endpoint = flags.endpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
const skipHydra = Boolean(flags["skip-hydra"]) || !endpoint;

// 1. Voters + base profiles
for (const v of VOTERS) {
  await User.updateOne(
    { _id: v.userId },
    { $set: { name: v.name, lastLogin: new Date() } },
    { upsert: true }
  );
}
console.log(`[mixed] seeded ${VOTERS.length} user profiles`);

// 2. Legacy ballots
const legacyBallots = [];
for (const spec of LEGACY_PLAN) {
  const b = await upsertScaffoldBallot({ source: "legacy", ...spec });
  legacyBallots.push(b);
  console.log(`[mixed] legacy  ${b.title} (${b._id})`);
}

// 3. Hydra ballot docs (+ /prepare if endpoint is available)
const hydraBallots = [];
for (const spec of HYDRA_PLAN) {
  const b = await upsertScaffoldBallot({
    source: "hydra",
    ...spec,
    provisionalResultsEnabled: true,
  });
  hydraBallots.push(b);

  if (skipHydra) {
    console.log(`[mixed] hydra   ${b.title} (${b._id}) — SKIPPED /prepare (${endpoint ? "use --force on scaffoldHydraBallot" : "no endpoint"})`);
    continue;
  }

  if (b.hydraEndpoint) {
    console.log(`[mixed] hydra   ${b.title} (${b._id}) — already prepared at ${b.hydraEndpoint}`);
    continue;
  }

  try {
    const client = forEndpoint(endpoint);
    const body = await buildPrepareBody(b);
    const data = await client.prepare(body);
    b.hydraEndpoint = endpoint;
    if (data?.ballotCid || data?.ballotIpfsCid)
      b.ballotCid = data.ballotCid || data.ballotIpfsCid;
    if (data?.instancePolicyId || data?.policyId)
      b.instancePolicyId = data.instancePolicyId || data.policyId;
    if (data?.hydraHeadId) b.hydraHeadId = data.hydraHeadId;
    await b.save();
    console.log(`[mixed] hydra   ${b.title} — prepared (namespace=${body.namespace})`);
  } catch (err) {
    const msg = err instanceof HydraClientError ? err.message : err.stack || err.message;
    console.warn(`[mixed] hydra   ${b.title} — /prepare FAILED: ${msg}`);
  }
}

// 4. Voter caches for every scaffolded ballot
for (const b of [...legacyBallots, ...hydraBallots]) {
  for (const v of VOTERS) {
    await UserCache.updateOne(
      { ballotId: b._id, userId: v.userId },
      { $set: { validated: v.validated, votingPower: v.votingPower, voterGroup: v.voterGroup } },
      { upsert: true }
    );
  }
}
console.log(
  `[mixed] voter caches written for ${legacyBallots.length + hydraBallots.length} ballots`
);

await teardown();
process.exit(0);
