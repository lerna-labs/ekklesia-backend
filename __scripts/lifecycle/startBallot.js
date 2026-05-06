// Start a Hydra ballot end-to-end: ensure scaffolded, wait for the prepare
// tx to confirm on L1, then call the backend's /start admin route.
//
// Usage:
//   node __scripts/lifecycle/startBallot.js --flavor dreps --state live
//   node __scripts/lifecycle/startBallot.js --ballotId 69...
//
// Flags:
//   --flavor / --state / --index   scaffold inputs (ignored if --ballotId set)
//   --ballotId                     skip scaffold; use this existing ballot
//   --force                        pass through to scaffold (re-prepare)
//   --skipWait                     don't poll Koios for prepare tx confirmation
//   --backend                      backend base URL (default http://localhost:$SERVER_PORT, or :3000)
//   --jwtUserId                    admin user id to mint a JWT with (uses
//                                  ADMIN_USER_IDS[0] when unset)

import process from "process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { bootstrap, teardown, parseArgs } from "../scaffold/common/env.js";
import { loadLocalOverrides } from "../../helper/envOverlay.js";
import { longFetch } from "../../helper/longFetch.js";
import { Ballot } from "../../schema/Ballot.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
const backend = flags.backend || `http://localhost:${process.env.SERVER_PORT || 3000}`;
const flavor = flags.flavor || "dreps";
const state = flags.state || "live";
const index = flags.index || "1";
const force = Boolean(flags.force);
const skipWait = Boolean(flags.skipWait);

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot });
}

// Step 1: scaffold (or skip if --ballotId is supplied)
let ballotId = flags.ballotId;
if (!ballotId) {
  const scaffoldArgs = [
    join(repoRoot, "__scripts/scaffold/scaffoldHydraBallot.js"),
    "--flavor", flavor,
    "--state", state,
    "--index", String(index),
  ];
  if (force) scaffoldArgs.push("--force");
  console.log("[startBallot] scaffolding …");
  run("node", scaffoldArgs);

  // Pull the ballotId from Mongo (title matches the deterministic format).
  await bootstrap();
  const title = `Scaffold/hydra/${flavor}/${state}#${String(index).padStart(3, "0")}`;
  const b = await Ballot.findOne({ title }).lean();
  if (!b) {
    console.error(`[startBallot] could not find scaffolded ballot ${title}`);
    await teardown();
    process.exit(1);
  }
  ballotId = b._id.toString();
  await teardown();
}
console.log(`[startBallot] ballotId = ${ballotId}`);

// Step 2: wait for prepare tx confirmation on L1
if (!skipWait) {
  console.log("[startBallot] waiting for /prepare L1 confirmation …");
  run("node", [join(repoRoot, "__scripts/waitForPrepareConfirmation.js"), "--ballotId", ballotId]);
}

// Step 3: mint an admin JWT + call /start
const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("JWT_SECRET missing from env");
  process.exit(1);
}
const adminId =
  flags.jwtUserId ||
  (process.env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)[0];
if (!adminId) {
  console.error(
    "No admin userId — pass --jwtUserId <bech32> or set ADMIN_USER_IDS in .env.local"
  );
  process.exit(1);
}
const adminJwt = jwt.sign(
  { userId: adminId, signType: "stake", multiSig: false, role: "admin" },
  secret,
  { expiresIn: process.env.JWT_MAX_AGE || "1h" }
);

console.log(`[startBallot] POST ${backend}/api/v1/admin/ballots/${ballotId}/start`);
// /start can take up to 12 min server-side (Hydra waitForHeadOpen 10 min
// + headroom). Use longFetch so undici's default 5-min headersTimeout
// doesn't abort us mid-wait.
const res = await longFetch(
  `${backend}/api/v1/admin/ballots/${ballotId}/start`,
  {
    method: "POST",
    headers: {
      cookie: `token=${adminJwt}`,
      "content-type": "application/json",
    },
    body: "{}",
  },
  { timeoutMs: 15 * 60_000 }
);
const body = await res.json().catch(() => ({}));
if (!res.ok || body.status === "error") {
  console.error("[startBallot] /start failed:", JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log("[startBallot] /start OK");
console.log(JSON.stringify(body, null, 2));
console.log("");
console.log("# paste this line into your shell:");
console.log(`export BALLOT='${ballotId}'`);
process.exit(0);
