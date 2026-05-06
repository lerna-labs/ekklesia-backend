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
import { buildPrepareBody } from "./common/hydraPrepare.js";
import { forEndpoint, HydraClientError } from "../../helper/hydraClient.js";
import { Ballot } from "../../schema/Ballot.js";

const { flags } = parseArgs();
const flavor = flags.flavor || "dreps";
const state = flags.state || "live";
const index = flags.index ? parseInt(flags.index, 10) : 1;
const force = Boolean(flags.force);

// bootstrap() loads .env.development + .env.local, so read HYDRA_DEFAULT_ENDPOINT
// AFTER bootstrap completes — reading before would miss env-file values.
await bootstrap();

const endpoint = flags.endpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
if (!endpoint) {
  console.error(
    "No Hydra endpoint available. Pass --endpoint=<url> or set HYDRA_DEFAULT_ENDPOINT."
  );
  await teardown();
  process.exit(1);
}

// On --force, clear the Hydra metadata stamped by a previous /prepare BEFORE
// the upsert runs. upsertScaffoldBallot only refreshes the voting window
// when the doc is "unanchored" (hydraEndpoint null); clearing these fields
// makes --force behave as a true re-prepare — fresh window, fresh L1 mint.
if (force) {
  const titlePrefix = "Scaffold";
  const title = `${titlePrefix}/hydra/${flavor}/${state}#${String(index).padStart(3, "0")}`;
  const reset = await Ballot.updateOne(
    { title },
    {
      $set: {
        hydraEndpoint: null,
        hydraHeadId: null,
        ballotCid: null,
        instancePolicyId: null,
        definitionAssetName: null,
        instanceAssetName: null,
        ballotFingerprint: null,
        timelockSlot: null,
        commitUtxos: [],
      },
    }
  );
  if (reset.matchedCount > 0) {
    console.log(`[scaffoldHydraBallot] --force: cleared prior Hydra metadata for ${title}`);
  }
}

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
  console.log(`  _id              = ${ballot._id}`);
  console.log(`  hydraEndpoint    = ${ballot.hydraEndpoint}`);
  console.log(`  ballotCid        = ${ballot.ballotCid}`);
  console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
  console.log("");
  console.log("# paste this line into your shell:");
  console.log(`export BALLOT='${ballot._id}'`);
  await teardown();
  process.exit(0);
}

try {
  const client = forEndpoint(endpoint);
  const body = await buildPrepareBody(ballot);
  console.log(`[scaffoldHydraBallot] calling ${endpoint}/prepare (namespace=${body.namespace}) …`);
  const data = await client.prepare(body);

  ballot.hydraEndpoint = endpoint;
  if (data?.txHash) {
    ballot.prepareTxHash = data.txHash;
    ballot.prepareTxSubmittedAt = new Date();
  }
  if (data?.ballotCid || data?.ballotIpfsCid)
    ballot.ballotCid = data.ballotCid || data.ballotIpfsCid;
  if (data?.policyId || data?.instancePolicyId)
    ballot.instancePolicyId = data.policyId || data.instancePolicyId;
  if (data?.definitionAssetName) ballot.definitionAssetName = data.definitionAssetName;
  if (data?.instanceAssetName) ballot.instanceAssetName = data.instanceAssetName;
  if (data?.fingerprint) ballot.ballotFingerprint = data.fingerprint;
  if (data?.timelockSlot !== undefined) ballot.timelockSlot = data.timelockSlot;
  if (Array.isArray(data?.commitUtxos)) ballot.commitUtxos = data.commitUtxos;
  if (data?.hydraHeadId) ballot.hydraHeadId = data.hydraHeadId;
  await ballot.save();

  const network = (process.env.NETWORK_NAME || "preprod").toLowerCase();
  const explorer =
    network === "mainnet"
      ? `https://cexplorer.io/tx/${ballot.prepareTxHash}`
      : `https://preprod.cexplorer.io/tx/${ballot.prepareTxHash}`;

  console.log(`[scaffoldHydraBallot] prepared ${ballot.title}`);
  console.log(`  _id              = ${ballot._id}`);
  console.log(`  namespace        = ${body.namespace}`);
  console.log(`  hydraEndpoint    = ${ballot.hydraEndpoint}`);
  console.log(`  prepareTxHash    = ${ballot.prepareTxHash || "(not returned)"}`);
  console.log(`  explorer         = ${ballot.prepareTxHash ? explorer : "-"}`);
  console.log(`  ballotCid        = ${ballot.ballotCid}`);
  console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
  console.log(`  hydraHeadId      = ${ballot.hydraHeadId || "(set on /start)"}`);
  console.log("");
  console.log("# paste this line into your shell:");
  console.log(`export BALLOT='${ballot._id}'`);
  console.log("");
  console.log("# Wait for the prepare tx to confirm before calling /start:");
  console.log(`node __scripts/waitForPrepareConfirmation.js --ballotId ${ballot._id}`);
} catch (err) {
  if (err instanceof HydraClientError) {
    console.error(
      `[scaffoldHydraBallot] Hydra /prepare failed: ${err.message}` +
        (err.data ? `\n  upstream: ${JSON.stringify(err.data)}` : "")
    );
    const apiKeyEnvVar = `HYDRA_API_KEY_${endpoint.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`;
    console.error(
      "\n  /prepare is NOT idempotent — it mints fresh tokens and spends\n" +
        "  admin wallet UTxOs on every call. Before retrying, confirm that\n" +
        "  no tokens were actually minted:\n" +
        `    curl -s -H "x-api-key: $${apiKeyEnvVar}" \\\n` +
        `         "${endpoint}/ballot" | jq '.'\n` +
        "  Check the admin L1 address on a preprod explorer, and if needed\n" +
        "  call POST /sweep on the Hydra service to recover residue before\n" +
        "  re-running this scaffold."
    );
  } else {
    console.error(`[scaffoldHydraBallot] unexpected error: ${err.stack || err.message}`);
  }
  process.exitCode = 1;
}

await teardown();
process.exit(process.exitCode || 0);
