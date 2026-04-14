// Multisig voter: mint JWT → /draft (with nativeScript) → sign canonical
// payload with `required` cosigner keys → /signature (one POST per
// witness; the backend aggregates until threshold is met, then submits).
//
// Usage:
//   node __scripts/vote/castVoteMultisig.js \
//     --ballotId $BALLOT \
//     --questionId <proposal _id> \
//     --selection 1
//
// Flags:
//   --ballotId            required
//   --questionId          required
//   --selection / --ranking / --weights   see castVote.js
//   --voter               fixture name (default: multisig)
//   --cosigners           how many keys to sign with (default = script.required)
//   --backend             backend URL (default http://localhost:3000)

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { parseArgs } from "../scaffold/common/env.js";
import { loadLocalOverrides } from "../../helper/envOverlay.js";
import { VOTERS_BY_NAME } from "../scaffold/common/fixtures.js";
import { signCose } from "../scaffold/common/coseSign.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
if (!flags.ballotId) { console.error("Missing --ballotId"); process.exit(1); }
if (!flags.questionId) { console.error("Missing --questionId"); process.exit(1); }

const fixture = VOTERS_BY_NAME[flags.voter || "multisig"];
if (!fixture || fixture.kind !== "script") {
  console.error("Voter fixture is not a multisig script-based voter");
  process.exit(1);
}
const script = fixture.nativeScript;
const keyPaths = fixture.keyPaths || [];
const required = script.required ?? keyPaths.length;
const count = Number(flags.cosigners || required);
if (count < required) {
  console.error(`--cosigners=${count} is below script threshold ${required}`);
  process.exit(1);
}
if (count > keyPaths.length) {
  console.error(`Only ${keyPaths.length} skey paths registered in fixture`);
  process.exit(1);
}

const selection = [];
for (const raw of [].concat(flags.selection || [])) {
  if (raw === true) continue;
  for (const v of String(raw).split(",")) selection.push(Number(v));
}
const ranking = [];
for (const raw of [].concat(flags.ranking || [])) {
  if (raw === true) continue;
  for (const v of String(raw).split(",")) ranking.push(Number(v));
}
let weights;
if (flags.weights) {
  weights = String(flags.weights).split(",").map((pair) => {
    const [option, weight] = pair.split(":").map(Number);
    return { option, weight };
  });
}
const voteSelection = { questionId: String(flags.questionId) };
if (selection.length) voteSelection.selection = selection;
if (ranking.length) voteSelection.ranking = ranking;
if (weights) voteSelection.weights = weights;
if (!voteSelection.selection && !voteSelection.ranking && !voteSelection.weights) {
  console.error("Pass one of --selection / --ranking / --weights");
  process.exit(1);
}

const backend = flags.backend || "http://localhost:3000";
const secret = process.env.JWT_SECRET;
if (!secret) { console.error("JWT_SECRET missing"); process.exit(1); }
const voterJwt = jwt.sign(
  { userId: fixture.userId, signType: "stake", multiSig: true },
  secret,
  { expiresIn: process.env.JWT_MAX_AGE || "1h" }
);
const headers = { cookie: `token=${voterJwt}`, "content-type": "application/json" };

console.log(`[multisig] voter=${fixture.userId.slice(0, 24)}… required=${required} signing-with=${count}`);
console.log(`[multisig] POST /draft (with nativeScript)`);
const draftRes = await fetch(`${backend}/api/v1/votes/${flags.ballotId}/draft`, {
  method: "POST",
  headers,
  body: JSON.stringify({ votes: [voteSelection], nativeScript: script }),
});
const draft = await draftRes.json().catch(() => ({}));
if (!draftRes.ok || draft.status !== "success") {
  console.error("/draft failed:", JSON.stringify(draft, null, 2));
  process.exit(1);
}
console.log(`  packageId=${draft.package.id} nonce=${draft.package.nonce}`);
console.log(
  `  multisig.outstanding=${draft.multisig?.outstandingKeys?.length ?? "?"}/${draft.multisig?.required ?? "?"}`
);

const messageToSign = draft.merkleRoot;
if (!messageToSign) {
  console.error("/draft response missing merkleRoot — is the broker up to date?");
  process.exit(1);
}

for (let i = 0; i < count; i++) {
  const skey = keyPaths[i];
  console.log(`[multisig] cosigner ${i + 1}/${count} signing merkleRoot=${messageToSign.slice(0, 16)}… with ${skey}`);
  // All cosigners sign against the SCRIPT DRep id — COSE header binds
  // to the script. signCose passes --nohashcheck so cardano-signer
  // accepts the key/address mismatch.
  const witness = await signCose(messageToSign, skey, fixture.userId);
  console.log(`  key=${witness.key?.slice(0, 16)}…`);
  const sigRes = await fetch(`${backend}/api/v1/votes/${flags.ballotId}/signature`, {
    method: "POST",
    headers,
    body: JSON.stringify({ packageId: draft.package.id, witness }),
  });
  const sig = await sigRes.json().catch(() => ({}));
  if (!sigRes.ok || sig.status !== "success") {
    console.error("/signature failed:", JSON.stringify(sig, null, 2));
    process.exit(1);
  }
  if (sig.submitted) {
    console.log(`[multisig] threshold met — submitted to Hydra`);
    console.log(`  status=${sig.package?.status}`);
    console.log(`  hydraTxId=${sig.package?.hydraTxId}`);
    console.log(`  ipfsCid=${sig.package?.ipfsCid}`);
  } else {
    const m = sig.multisig || {};
    console.log(
      `  still awaiting signatures (outstanding=${m.outstandingKeys?.length ?? "?"})`
    );
  }
}
process.exit(0);
