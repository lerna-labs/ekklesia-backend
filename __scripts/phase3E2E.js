// Phase 3 end-to-end orchestrator. Drives a full voting lifecycle with
// minimal hand-holding:
//   1. scaffoldHydraBallot (start if needed)
//   2. wait for prepare L1 confirmation
//   3. seedVoters (pin cache rows for the fixtures)
//   4. /start the head
//   5. castVote single-sig (drep01)
//   6. castVoteMultisig (real preprod DRep, 2-of-3)
//   7. closeBallot — settle/burn → settle/finalize → settle/close
//
// Skips #5/#6 if --skipVotes is set. Skips #7 if --keepOpen is set
// (useful when you want to inspect the head before tearing down).
//
// Usage:
//   node __scripts/phase3E2E.js --closeToken shutitdown
//   node __scripts/phase3E2E.js --closeToken shutitdown --force
//   node __scripts/phase3E2E.js --ballotId 69... --closeToken shutitdown

import process from "process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { bootstrap, teardown, parseArgs } from "./scaffold/common/env.js";
import { loadLocalOverrides } from "../helper/envOverlay.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
const flavor = flags.flavor || "dreps";
const state = flags.state || "live";
const index = flags.index || "1";
const force = Boolean(flags.force);
const skipVotes = Boolean(flags.skipVotes);
const keepOpen = Boolean(flags.keepOpen);
const closeToken = flags.closeToken || process.env.HYDRA_CLOSE_TOKEN || "shutitdown";
const backend = flags.backend || "http://localhost:3000";

function run(script, extra = []) {
  const args = [join(repoRoot, script), ...extra, "--backend", backend];
  execFileSync("node", args, { stdio: "inherit", cwd: repoRoot });
}

// ---- 1. scaffold + start ---------------------------------------------------
const startArgs = [
  "--flavor", flavor,
  "--state", state,
  "--index", String(index),
];
if (flags.ballotId) startArgs.push("--ballotId", flags.ballotId);
if (force) startArgs.push("--force");
run("__scripts/lifecycle/startBallot.js", startArgs);

// startBallot.js prints `export BALLOT='...'` but we need the id in this
// process. Re-resolve it from Mongo using the deterministic title.
await bootstrap();
const title = flags.ballotId
  ? null
  : `Scaffold/hydra/${flavor}/${state}#${String(index).padStart(3, "0")}`;
const ballot = flags.ballotId
  ? await Ballot.findById(flags.ballotId).lean()
  : await Ballot.findOne({ title }).lean();
if (!ballot) {
  console.error("[phase3E2E] could not resolve ballot after start");
  await teardown();
  process.exit(1);
}
const ballotId = ballot._id.toString();
console.log(`[phase3E2E] BALLOT=${ballotId} (${ballot.title})`);

// Pick the first proposal to vote on.
const proposal = await Proposal.findOne({ ballotId: ballot._id }).lean();
if (!proposal) {
  console.error("[phase3E2E] no proposals on ballot");
  await teardown();
  process.exit(1);
}
const questionId = proposal._id.toString();
await teardown();

// ---- 2. seed voters --------------------------------------------------------
run("__scripts/scaffold/seedVoters.js", ["--ballotId", ballotId]);

// ---- 3. single-sig vote (drep01) ------------------------------------------
if (!skipVotes) {
  console.log(`[phase3E2E] casting single-sig vote on question ${questionId}`);
  run("__scripts/vote/castVote.js", [
    "--ballotId", ballotId,
    "--voter", "drep01",
    "--questionId", questionId,
    "--selection", "1",
  ]);

  // ---- 4. multisig vote (real preprod DRep) -------------------------------
  console.log(`[phase3E2E] casting multisig vote on question ${questionId}`);
  run("__scripts/vote/castVoteMultisig.js", [
    "--ballotId", ballotId,
    "--voter", "multisig",
    "--questionId", questionId,
    "--selection", "2",
  ]);
}

// ---- 5. close the head -----------------------------------------------------
if (keepOpen) {
  console.log(`[phase3E2E] --keepOpen set, skipping close. Ballot is still Open.`);
  console.log(`export BALLOT='${ballotId}'`);
  process.exit(0);
}
run("__scripts/lifecycle/closeBallot.js", [
  "--ballotId", ballotId,
  "--closeToken", closeToken,
]);

console.log(`[phase3E2E] DONE — ballot ${ballotId} cycled cleanly`);
process.exit(0);
