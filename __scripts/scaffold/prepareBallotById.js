// Drive Hydra /prepare for an existing Ballot by `_id`.
//
// A narrow companion to scaffoldHydraBallot.js: same prepare flow
// (buildPrepareBody -> Hydra client -> stamp response onto Ballot doc),
// but targets an arbitrary ballotId rather than a scaffold-titled one.
// Use it for imported ballots (e.g. the Budget 2026 CompiledBallot) and
// any future "ballot is already in the DB, please prepare it" case.
//
// Requires:
//   - DB access to the instance the ballot lives in (env-pointed Mongo).
//   - Network reachability to the Hydra endpoint (its API key, if any,
//     comes from HYDRA_API_KEY_<endpoint-slug> env per hydraClient).
//
// Usage:
//   node __scripts/scaffold/prepareBallotById.js --ballotId <id>
//   node __scripts/scaffold/prepareBallotById.js --ballotId <id> \
//        --namespace vote.ekklesia.cardano-budget-2026
//   node __scripts/scaffold/prepareBallotById.js --ballotId <id> --dry-run
//   node __scripts/scaffold/prepareBallotById.js --ballotId <id> --force
//
// Flags:
//   --ballotId          (required) Mongo _id of the Ballot to prepare.
//   --namespace         Hydra namespace (advised for production ballots —
//                       see hydraPrepare.js JSDoc). Defaults to the
//                       title-derived namespaceForTitle(ballot.title).
//   --endpoint          Hydra endpoint URL. Falls back to
//                       ballot.hydraEndpoint, then HYDRA_DEFAULT_ENDPOINT.
//   --votingAuthority   Override ballot.voteAuthorityAddress (advisory
//                       field in the prepare body).
//   --gas               ADA on the (601) instance-token UTxO. Default 5.
//   --force             Clear prior Hydra metadata (hydraEndpoint,
//                       ballotCid, instancePolicyId, etc.) before
//                       re-preparing. /prepare is NOT idempotent — only
//                       use --force after confirming no L1 tokens were
//                       actually minted on the previous attempt.
//   --dry-run           Build + print the prepare body; do not POST.

import process from 'process';
import { bootstrap, teardown, parseArgs } from './common/env.js';
import { buildPrepareBody, namespaceForTitle } from './common/hydraPrepare.js';
import { forEndpoint, HydraClientError } from '../../helper/hydraClient.js';
import { Ballot } from '../../schema/Ballot.js';

const HYDRA_METADATA_FIELDS = [
  'hydraEndpoint',
  'hydraHeadId',
  'ballotCid',
  'instancePolicyId',
  'definitionAssetName',
  'instanceAssetName',
  'ballotFingerprint',
  'timelockSlot',
  'prepareTxHash',
  'prepareTxSubmittedAt',
];

function explorerUrl(txHash) {
  if (!txHash) return null;
  const network = (process.env.NETWORK_NAME || 'preprod').toLowerCase();
  const host = network === 'mainnet' ? 'https://cexplorer.io' : 'https://preprod.cexplorer.io';
  return `${host}/tx/${txHash}`;
}

async function main(flags) {
  await bootstrap();
  try {
    return await runPrepare(flags);
  } finally {
    await teardown();
  }
}

async function runPrepare(flags) {
  const ballot = await Ballot.findById(flags.ballotId);
  if (!ballot) {
    console.error(`[prepareBallotById] no Ballot with _id=${flags.ballotId}`);
    return 1;
  }

  // Refuse to re-prepare an already-prepared ballot without --force.
  // Hydra /prepare mints fresh L1 tokens on every call.
  if (ballot.hydraEndpoint && !flags.force) {
    console.log(
      `[prepareBallotById] ${ballot.title} is already prepared at ` +
        `${ballot.hydraEndpoint}. Pass --force to re-prepare (only after ` +
        `confirming the prior /prepare did NOT actually mint).`,
    );
    console.log(`  _id              = ${ballot._id}`);
    console.log(`  ballotCid        = ${ballot.ballotCid}`);
    console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
    return 0;
  }

  if (flags.force && ballot.hydraEndpoint) {
    const $set = {};
    for (const f of HYDRA_METADATA_FIELDS) $set[f] = null;
    $set.commitUtxos = [];
    await Ballot.updateOne({ _id: ballot._id }, { $set });
    for (const f of HYDRA_METADATA_FIELDS) ballot[f] = null;
    ballot.commitUtxos = [];
    console.log(`[prepareBallotById] --force: cleared prior Hydra metadata for ${ballot.title}`);
  }

  const endpoint = flags.endpoint || ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
  const isDryRun = flags['dry-run'] || flags.dryRun;
  if (!endpoint && !isDryRun) {
    console.error(
      '[prepareBallotById] no Hydra endpoint. Pass --endpoint=<url>, set ' +
        'HYDRA_DEFAULT_ENDPOINT, or stamp ballot.hydraEndpoint.',
    );
    return 1;
  }

  const namespace = flags.namespace || namespaceForTitle(ballot.title);
  const opts = {
    namespace,
    ...(flags.votingAuthority ? { votingAuthority: flags.votingAuthority } : {}),
    ...(flags.gas != null ? { gasAmount: Number(flags.gas) } : {}),
  };
  const body = await buildPrepareBody(ballot, opts);

  if (isDryRun) {
    console.log('[prepareBallotById] --dry-run: built body, NOT posting');
    console.log(`  endpoint       = ${endpoint || '(none — would error)'}`);
    console.log(`  namespace      = ${body.namespace}`);
    console.log(`  questions      = ${body.ballot.questions.length}`);
    console.log(`  endEpoch       = ${body.ballot.endEpoch}`);
    console.log(
      `  votingWindow   = ${body.ballot.ekklesia.votingWindow.open} → ${body.ballot.ekklesia.votingWindow.close}`,
    );
    console.log(`  votingAuthority= ${body.ballot.ekklesia.votingAuthority || '(empty)'}`);
    console.log(`  gasAmount      = ${body.gasAmount}`);
    console.log('');
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }

  console.log(`[prepareBallotById] calling ${endpoint}/prepare (namespace=${body.namespace}) …`);
  const client = forEndpoint(endpoint);
  const data = await client.prepare(body);

  // Stamp the response onto the ballot — same field set as
  // scaffoldHydraBallot.js so the rest of the lifecycle (autoFillFromBallot,
  // /start, /settle/*) finds everything it needs.
  ballot.source = 'hydra';
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

  console.log(`[prepareBallotById] prepared ${ballot.title}`);
  console.log(`  _id              = ${ballot._id}`);
  console.log(`  namespace        = ${body.namespace}`);
  console.log(`  hydraEndpoint    = ${ballot.hydraEndpoint}`);
  console.log(`  prepareTxHash    = ${ballot.prepareTxHash || '(not returned)'}`);
  console.log(`  explorer         = ${explorerUrl(ballot.prepareTxHash) || '-'}`);
  console.log(`  ballotCid        = ${ballot.ballotCid}`);
  console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
  console.log(`  hydraHeadId      = ${ballot.hydraHeadId || '(set on /start)'}`);
  console.log('');
  console.log('# paste this line into your shell:');
  console.log(`export BALLOT='${ballot._id}'`);
  console.log('');
  console.log('# Wait for the prepare tx to confirm before calling /start:');
  console.log(`node __scripts/waitForPrepareConfirmation.js --ballotId ${ballot._id}`);
  return 0;
}

const { flags } = parseArgs();
if (!flags.ballotId) {
  console.error('[prepareBallotById] --ballotId is required');
  process.exit(1);
}

let exitCode;
try {
  exitCode = (await main(flags)) || 0;
} catch (err) {
  if (err instanceof HydraClientError) {
    console.error(
      `[prepareBallotById] Hydra /prepare failed: ${err.message}` +
        (err.data ? `\n  upstream: ${JSON.stringify(err.data)}` : ''),
    );
    console.error(
      '\n  /prepare is NOT idempotent — it mints fresh tokens and spends\n' +
        '  admin wallet UTxOs on every call. Before retrying with --force,\n' +
        "  confirm no tokens were actually minted: check the Hydra service's\n" +
        '  /ballot list and the admin L1 address on the chain explorer, and\n' +
        '  call POST /sweep on the Hydra service to recover residue if needed.',
    );
  } else {
    console.error(`[prepareBallotById] unexpected error: ${err.stack || err.message}`);
  }
  exitCode = 1;
}
process.exit(exitCode);
