// Close a Hydra ballot via the canonical stepped settlement sequence:
//   1. POST /settle/burn (loops until remaining === 0)
//   2. POST /settle/finalize
//   3. POST /settle/close
//
// Usage:
//   node __scripts/lifecycle/closeBallot.js --ballotId 69... --closeToken shutitdown
//
// Flags:
//   --ballotId           required
//   --closeToken         required (matches Hydra's CLOSE_TOKEN env)
//   --backend            backend base URL (default http://localhost:3000)
//   --jwtUserId          admin user id (uses ADMIN_USER_IDS[0] when unset)
//   --maxBurnRounds      safety cap on /settle/burn iterations (default 20)

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { parseArgs } from "../scaffold/common/env.js";
import { loadLocalOverrides } from "../../helper/envOverlay.js";
import { longFetch } from "../../helper/longFetch.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
if (!flags.ballotId) {
  console.error("Missing --ballotId");
  process.exit(1);
}
if (!flags.closeToken) {
  console.error("Missing --closeToken");
  process.exit(1);
}
const backend = flags.backend || "http://localhost:3000";
const maxBurnRounds = Number(flags.maxBurnRounds || 20);

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("JWT_SECRET missing from env");
  process.exit(1);
}
const adminId =
  flags.jwtUserId ||
  (process.env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)[0];
if (!adminId) {
  console.error("No admin userId — pass --jwtUserId or set ADMIN_USER_IDS");
  process.exit(1);
}
const adminJwt = jwt.sign(
  { userId: adminId, signType: "stake", multiSig: false, role: "admin" },
  secret,
  { expiresIn: process.env.JWT_MAX_AGE || "1h" }
);

// Per-path timeout for the outbound POST. Must be >= the backend's own
// timeout to Hydra (hydraClient POST_TIMEOUTS_MS) so we don't abort
// while the backend is still waiting on Hydra. /settle/close can take
// up to 15 min server-side (fanout).
const PATH_TIMEOUTS_MS = {
  "/settle/burn": 12 * 60_000,
  "/settle/finalize": 7 * 60_000,
  "/settle/close": 18 * 60_000,
};
function timeoutForPath(path) {
  for (const [prefix, ms] of Object.entries(PATH_TIMEOUTS_MS)) {
    if (path.endsWith(prefix)) return ms;
  }
  return 60_000;
}

async function post(path, body) {
  const res = await longFetch(
    `${backend}${path}`,
    {
      method: "POST",
      headers: {
        cookie: `token=${adminJwt}`,
        "content-type": "application/json",
      },
      body: body === undefined ? "{}" : JSON.stringify(body),
    },
    { timeoutMs: timeoutForPath(path) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// Pre-flight: if the head is already FINAL (upstream finalized without
// us stamping the Ballot doc), skip burn + finalize — both would 500
// on a head that no longer has a snapshot. Just call /settle/close,
// which short-circuits to { status: 'FINAL', message: 'Head already
// finalized' } and lets our admin route sync the Ballot doc state.
async function get(path) {
  const res = await longFetch(
    `${backend}${path}`,
    { method: "GET", headers: { cookie: `token=${adminJwt}` } },
    { timeoutMs: 30_000 }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

console.log("[closeBallot] GET /head-info (preflight)");
const headInfo = await get(`/api/v1/admin/ballots/${flags.ballotId}/head-info`);
const headStatus = headInfo?.hydra?.headStatus || headInfo?.hydra?.status || "(unknown)";
console.log(`  headStatus=${headStatus}`);

// Finalized upstream: /settle/close short-circuits, admin route stamps
// the Ballot doc via syncHeadStateToBallot.
if (["FINAL", "Final"].includes(headStatus)) {
  console.log("[closeBallot] head already finalized upstream — syncing ballot doc and exiting.");
  const closeData = await post(
    `/api/v1/admin/ballots/${flags.ballotId}/settle/close`,
    { closeToken: flags.closeToken }
  );
  console.log("  " + JSON.stringify(closeData.hydra));
  console.log("[closeBallot] done — ballot marked closed, head in state " + (closeData.ballot?.hydraHeadStatus || "?"));
  process.exit(0);
}

// Orphaned: hydra-node was wiped or the head was never opened for this
// ballot. There's nothing to burn/finalize/close upstream — /settle/burn
// will 500 because the snapshot doesn't exist. Just mark the Ballot doc
// locally so the unified listing shows it as closed.
if (["Idle", "Unknown", null, undefined, "(unknown)"].includes(headStatus)) {
  console.log(
    "[closeBallot] head is Idle — the hydra-node has no record of this ballot's head.\n" +
      "               marking the Mongo ballot doc closed locally (no Hydra calls)."
  );
  const mongoose = (await import("mongoose")).default;
  const { Ballot } = await import("../../schema/Ballot.js");
  const { connectToDatabase, disconnectFromDatabase } = await import(
    "../../helper/dbManager.js"
  );
  await connectToDatabase();
  const updated = await Ballot.findByIdAndUpdate(
    flags.ballotId,
    {
      $set: {
        status: "closed",
        hydraHeadStatus: "Final",
      },
    },
    { new: true }
  ).lean();
  await disconnectFromDatabase();
  if (!updated) {
    console.error(`[closeBallot] Ballot ${flags.ballotId} not found in Mongo`);
    process.exit(1);
  }
  console.log("[closeBallot] done — ballot doc marked status=closed, hydraHeadStatus=Final");
  console.log(
    "  Note: if you want to also clean up L1 tokens, call Hydra /prepare/cancel\n" +
      "  for this ballot's namespace before the timelock expires."
  );
  process.exit(0);
}

// Step 1: burn — loop until remaining === 0
for (let round = 1; round <= maxBurnRounds; round++) {
  console.log(`[closeBallot] /settle/burn (round ${round})`);
  const data = await post(`/api/v1/admin/ballots/${flags.ballotId}/settle/burn`);
  const hydra = data.hydra || {};
  console.log(
    `  burned=${hydra.burned ?? 0} failed=${hydra.failed ?? 0} remaining=${hydra.remaining ?? "?"} total=${hydra.total ?? "?"}`
  );
  if ((hydra.remaining ?? 0) === 0) break;
  if (round === maxBurnRounds) {
    console.error(`[closeBallot] hit maxBurnRounds=${maxBurnRounds} with remaining=${hydra.remaining}`);
    process.exit(1);
  }
}

// Step 2: finalize
console.log("[closeBallot] /settle/finalize");
const finalizeData = await post(`/api/v1/admin/ballots/${flags.ballotId}/settle/finalize`);
console.log("  " + JSON.stringify(finalizeData.hydra));

// Step 3: close
console.log("[closeBallot] /settle/close");
const closeData = await post(
  `/api/v1/admin/ballots/${flags.ballotId}/settle/close`,
  { closeToken: flags.closeToken }
);
console.log("  " + JSON.stringify(closeData.hydra));
console.log("[closeBallot] done — ballot closed, head in state " + (closeData.ballot?.hydraHeadStatus || "?"));
process.exit(0);
