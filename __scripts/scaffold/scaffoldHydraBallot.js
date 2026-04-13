// Scaffold a Hydra-backed ballot (idempotent at the Ballot doc level; the
// Hydra-side L1 mint is NOT idempotent — re-runs on an already-prepared
// ballot will skip the /prepare call unless --force is passed).
//
// Requires a reachable Hydra instance. By default uses HYDRA_DEFAULT_ENDPOINT
// from env; override with --endpoint.
//
// Usage:
//   node __scripts/scaffold/scaffoldHydraBallot.js --flavor dreps --state live
//   node __scripts/scaffold/scaffoldHydraBallot.js --endpoint https://hydra.preprod.example --flavor dreps --state live
//   node __scripts/scaffold/scaffoldHydraBallot.js --flavor dreps --state live --force

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { upsertScaffoldBallot } from "./common/ballotFactory.js";
import { forEndpoint, HydraClientError } from "../../helper/hydraClient.js";
import { Ballot } from "../../schema/Ballot.js";

const { flags } = parseArgs();
const flavor = flags.flavor || "dreps";
const state = flags.state || "live";
const index = flags.index ? parseInt(flags.index, 10) : 1;
const force = Boolean(flags.force);
const endpoint = flags.endpoint || process.env.HYDRA_DEFAULT_ENDPOINT;

if (!endpoint) {
  console.error(
    "No Hydra endpoint available. Pass --endpoint=<url> or set HYDRA_DEFAULT_ENDPOINT."
  );
  process.exit(1);
}

await bootstrap();

const ballot = await upsertScaffoldBallot({
  source: "hydra",
  state,
  flavor,
  index,
  provisionalResultsEnabled: true,
});

if (ballot.hydraEndpoint && !force) {
  console.log(
    `[scaffoldHydraBallot] ${ballot.title} already prepared at ${ballot.hydraEndpoint}. Pass --force to re-prepare.`
  );
  await teardown();
  process.exit(0);
}

try {
  const client = forEndpoint(endpoint);
  console.log(`[scaffoldHydraBallot] calling ${endpoint}/prepare …`);
  const data = await client.prepare({
    title: ballot.title,
    description: ballot.description,
    votePeriodStart: ballot.votePeriodStart,
    votePeriodEnd: ballot.votePeriodEnd,
  });

  ballot.hydraEndpoint = endpoint;
  if (data?.ballotCid) ballot.ballotCid = data.ballotCid;
  if (data?.instancePolicyId) ballot.instancePolicyId = data.instancePolicyId;
  if (data?.hydraHeadId) ballot.hydraHeadId = data.hydraHeadId;
  await ballot.save();

  console.log(`[scaffoldHydraBallot] prepared ${ballot.title}`);
  console.log(`  hydraEndpoint    = ${ballot.hydraEndpoint}`);
  console.log(`  ballotCid        = ${ballot.ballotCid}`);
  console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
  console.log(`  hydraHeadId      = ${ballot.hydraHeadId}`);
} catch (err) {
  if (err instanceof HydraClientError) {
    console.error(
      `[scaffoldHydraBallot] Hydra /prepare failed: ${err.message}` +
        (err.data ? `\n  upstream: ${JSON.stringify(err.data)}` : "")
    );
  } else {
    console.error(`[scaffoldHydraBallot] unexpected error: ${err.stack || err.message}`);
  }
  process.exitCode = 1;
}

await teardown();
process.exit(process.exitCode || 0);
