// Drive Hydra /start for a prepared Ballot by `_id`.
//
// Companion to prepareBallotById.js. After /prepare lands and the prepare
// tx confirms on-chain (see waitForPrepareConfirmation.js), /start
// commits the (601) instance token into the Hydra head and opens it.
//
// Mirrors what `routes/api/v1/admin/ballots.js`'s POST /:id/start does —
// autoFillFromBallot + client.start() + syncHeadStateToBallot — but as a
// standalone scripted path that talks direct-to-Hydra (no backend admin
// JWT required, same auth model as prepareBallotById.js).
//
// Requires:
//   - DB access to the instance the ballot lives in (env-pointed Mongo).
//   - Network reachability to the Hydra endpoint stamped by /prepare.
//   - The /prepare tx must be CONFIRMED on-chain before /start runs.
//
// Footguns from CLAUDE.md you should know:
//   - Hydra's deposit window (≈3600s) starts at /prepare. If too much time
//     elapses, /start can silently no-op — returning
//     `200 SUCCESS { ballotCached: false }` — the commit drops on the
//     hydra-node side without a clean error, and every subsequent /vote
//     will 503 with NO_BALLOT_CACHED. This script surfaces that response
//     loudly so you don't miss it.
//   - /start is NOT idempotent. If Hydra errors AFTER the commit tx
//     actually lands, retrying with the same UTxO will fail (UTxO is
//     already spent into the head). Read the response carefully before
//     retrying.
//
// Usage:
//   node __scripts/scaffold/startBallotById.js --ballotId <id>
//   node __scripts/scaffold/startBallotById.js --ballotId <id> --dry-run

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { forBallot, HydraClientError } from "../../helper/hydraClient.js";
import { Ballot } from "../../schema/Ballot.js";

const REQUIRED = ["utxos", "ballotPolicy", "ballotToken"];

/**
 * Auto-fill the /start body from the stamped Ballot doc — mirrors
 * autoFillFromBallot() in routes/api/v1/admin/ballots.js so the script
 * doesn't need the backend running.
 */
function bodyFromBallot(ballot) {
  const out = { ballotId: ballot._id };
  if (ballot.instancePolicyId) out.ballotPolicy = ballot.instancePolicyId;
  if (ballot.instanceAssetName) out.ballotToken = ballot.instanceAssetName;
  if (ballot.definitionAssetName) out.ballotName = ballot.definitionAssetName;
  if (ballot.ballotCid) out.ballotIpfsCid = ballot.ballotCid;
  if (Array.isArray(ballot.commitUtxos) && ballot.commitUtxos.length) {
    out.utxos = ballot.commitUtxos.map((u) => ({
      txHash: u.txHash,
      outputIndex: u.outputIndex,
    }));
  }
  return out;
}

/**
 * Mirror /head-info onto the ballot — same write set the admin route
 * uses post-/start so the rest of the lifecycle (autoFillFromBallot for
 * /settle/*, dashboard, etc.) finds hydraHeadId + hydraHeadStatus.
 */
async function syncHeadStateToBallot(ballotId, client, { status } = {}) {
  let hydraHeadId = null;
  let hydraHeadStatus = null;
  try {
    const info = await client.headInfo();
    hydraHeadId = info?.headId || info?.hydraHeadId || null;
    hydraHeadStatus = info?.headStatus || info?.status || null;
  } catch (e) {
    console.warn(`[startBallotById] /head-info fetch failed: ${e.message}`);
  }
  const update = {};
  if (hydraHeadId) update.hydraHeadId = hydraHeadId;
  if (hydraHeadStatus) update.hydraHeadStatus = hydraHeadStatus;
  if (status) update.status = status;
  if (Object.keys(update).length) {
    await Ballot.updateOne({ _id: ballotId }, { $set: update });
  }
  return { hydraHeadId, hydraHeadStatus, status };
}

async function main(flags) {
  await bootstrap();
  try {
    return await runStart(flags);
  } finally {
    await teardown();
  }
}

async function runStart(flags) {
  const ballot = await Ballot.findById(flags.ballotId);
  if (!ballot) {
    console.error(`[startBallotById] no Ballot with _id=${flags.ballotId}`);
    return 1;
  }
  if (!ballot.hydraEndpoint) {
    console.error(
      `[startBallotById] ballot ${ballot._id} has no hydraEndpoint — run ` +
        `/prepare first (prepareBallotById.js).`
    );
    return 1;
  }

  const body = bodyFromBallot(ballot);
  const missing = REQUIRED.filter(
    (k) => body[k] === undefined || body[k] === null || body[k] === ""
  );
  if (missing.length) {
    console.error(
      `[startBallotById] missing required field(s) for /start: ` +
        `${missing.join(", ")}. These are stamped by /prepare — was the ` +
        `prepare tx confirmed and the ballot doc refreshed?`
    );
    return 1;
  }

  const isDryRun = flags["dry-run"] || flags.dryRun;
  if (isDryRun) {
    console.log("[startBallotById] --dry-run: built body, NOT calling /start");
    console.log(`  endpoint       = ${ballot.hydraEndpoint}`);
    console.log(`  ballotId       = ${body.ballotId}`);
    console.log(`  ballotPolicy   = ${body.ballotPolicy}`);
    console.log(`  ballotToken    = ${body.ballotToken}`);
    console.log(`  ballotName     = ${body.ballotName}`);
    console.log(`  ballotIpfsCid  = ${body.ballotIpfsCid}`);
    console.log(`  utxos          = ${JSON.stringify(body.utxos)}`);
    return 0;
  }

  console.log(
    `[startBallotById] calling ${ballot.hydraEndpoint}/start (ballotId=${ballot._id}) …`
  );
  const client = await forBallot(ballot._id);
  const data = await client.start(body);

  // CLAUDE.md: /start can silently no-op on expired deposit windows.
  // Surface that loudly — otherwise the head stays Idle and /vote 503s.
  if (data && data.ballotCached === false) {
    console.error(
      "\n[startBallotById] ⚠️  /start returned ballotCached:false — Hydra " +
        "accepted the call but did NOT actually open the head (most likely " +
        "the deposit window has expired since /prepare). The head will stay " +
        "Idle; any /vote will fail with NO_BALLOT_CACHED. Re-open the head " +
        "before retrying.\n"
    );
  }

  const synced = await syncHeadStateToBallot(ballot._id, client, {
    status: "live",
  });

  console.log(`[startBallotById] /start completed`);
  console.log(`  ballotCached     = ${data?.ballotCached ?? "(not in response)"}`);
  console.log(`  hydraHeadId      = ${synced.hydraHeadId || "(none)"}`);
  console.log(`  hydraHeadStatus  = ${synced.hydraHeadStatus || "(unknown)"}`);
  console.log(`  ballot.status    = ${synced.status || "(unchanged)"}`);
  console.log("");
  console.log("# Hydra raw response:");
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

const { flags } = parseArgs();
if (!flags.ballotId) {
  console.error("[startBallotById] --ballotId is required");
  process.exit(1);
}

let exitCode = 0;
try {
  exitCode = (await main(flags)) || 0;
} catch (err) {
  if (err instanceof HydraClientError) {
    console.error(
      `[startBallotById] Hydra /start failed: ${err.message}` +
        (err.data ? `\n  upstream: ${JSON.stringify(err.data)}` : "")
    );
    console.error(
      "\n  /start is NOT retry-safe. If the commit tx actually landed but\n" +
        "  Hydra returned an error, retrying with the same UTxO will fail\n" +
        "  (UTxO already spent into the head). Check the Hydra service's\n" +
        "  /ballot list and the admin L1 address on a chain explorer\n" +
        "  before retrying."
    );
  } else {
    console.error(
      `[startBallotById] unexpected error: ${err.stack || err.message}`
    );
  }
  exitCode = 1;
}
process.exit(exitCode);
