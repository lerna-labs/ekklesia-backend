// Single-sig voter: mint JWT → /draft → sign canonical payload via
// cardano-signer → /signature → print the confirmed VotePackage.
//
// Usage:
//   node __scripts/vote/castVote.js \
//     --ballotId $BALLOT \
//     --voter drep01 \
//     --questionId <proposal _id> \
//     --selection 1
//
// Flags:
//   --ballotId     required
//   --voter        fixture name in VOTERS_BY_NAME (default: drep01)
//   --questionId   required — Proposal _id on the ballot
//   --selection    Ballot-schema-v2 unified selection. Two shapes accepted:
//                    - integers: "1" or "1,3" (binary / single / multi /
//                      range; ranked passes in preference order)
//                    - option:value pairs: "1:5,2:3,3:1" for weighted
//                      (value = points, must sum to budget) or likert
//                      (value = rating on ratingRange grid)
//                  Repeatable; repeats flatten into one selection array.
//                  Mutually exclusive with --abstain.
//   --abstain      Submits { questionId, abstain: true } — the voter
//                  skips this question without expressing a preference.
//                  Proposal must have abstainAllowed: true.
//   --skeyPath     override the fixture's keyPath
//   --backend      backend base URL (default http://localhost:$SERVER_PORT, or :3000)

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { parseArgs } from "../scaffold/common/env.js";
import { loadLocalOverrides } from "../../helper/envOverlay.js";
import { VOTERS_BY_NAME, SINGLE_SIG_VOTER } from "../scaffold/common/fixtures.js";
import { signCose } from "../scaffold/common/coseSign.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
if (!flags.ballotId) { console.error("Missing --ballotId"); process.exit(1); }
if (!flags.questionId) { console.error("Missing --questionId"); process.exit(1); }

const voterName = flags.voter || "drep01";
const fixture = VOTERS_BY_NAME[voterName] || SINGLE_SIG_VOTER;
const skeyPath = flags.skeyPath || fixture.keyPath || SINGLE_SIG_VOTER.keyPath;
if (!skeyPath) {
  console.error(`Voter ${voterName} has no keyPath; pass --skeyPath explicitly`);
  process.exit(1);
}
if (fixture.kind === "script") {
  console.error(`Voter ${voterName} is script-based — use castVoteMultisig.js`);
  process.exit(1);
}
const voterId = fixture.userId;
const backend = flags.backend || `http://localhost:${process.env.SERVER_PORT || 3000}`;

// Parse --selection into Hydra v2 unified selection (number[] or
// SelectionEntry[]). An entry is {option,value} when the token contains
// a colon, plain integer otherwise. Mixing shapes inside one --selection
// is rejected — Hydra's validator enforces one shape per method.
function parseSelection(rawFlags) {
  const tokens = [];
  for (const raw of [].concat(rawFlags || [])) {
    if (raw === true) continue;
    for (const t of String(raw).split(",")) {
      const trimmed = t.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }
  if (tokens.length === 0) return null;
  const hasPair = tokens.some((t) => t.includes(":"));
  if (hasPair && !tokens.every((t) => t.includes(":"))) {
    console.error("--selection: mixed shapes; use all integers OR all option:value pairs");
    process.exit(1);
  }
  if (hasPair) {
    return tokens.map((t) => {
      const [option, value] = t.split(":").map(Number);
      return { option, value };
    });
  }
  return tokens.map(Number);
}

const wantsAbstain = flags.abstain === true || String(flags.abstain) === "true";
const selection = parseSelection(flags.selection);

if (wantsAbstain && selection) {
  console.error("--abstain and --selection are mutually exclusive");
  process.exit(1);
}
if (!wantsAbstain && !selection) {
  console.error("Pass --selection (integers, or option:value pairs for weighted/likert) or --abstain");
  process.exit(1);
}

const voteSelection = wantsAbstain
  ? { questionId: String(flags.questionId), abstain: true }
  : { questionId: String(flags.questionId), selection };

// Mint voter JWT.
const secret = process.env.JWT_SECRET;
if (!secret) { console.error("JWT_SECRET missing"); process.exit(1); }
const voterJwt = jwt.sign(
  { userId: voterId, signType: "stake", multiSig: false },
  secret,
  { expiresIn: process.env.JWT_MAX_AGE || "1h" }
);
const headers = {
  cookie: `token=${voterJwt}`,
  "content-type": "application/json",
};

console.log(`[castVote] voter=${voterName} (${voterId})`);
console.log(`[castVote] POST /api/v1/votes/${flags.ballotId}/draft`);
// CIP-151 calidus-signed SPO votes: voterId is the pool bech32, signing
// key is the calidus hot key. Hydra needs the calidus declaration in the
// evidence package so it can verify the COSE witness against the on-chain
// calidus binding (pool → calidus pubkey) rather than the pool cold key.
const draftBody = { votes: [voteSelection] };
if (fixture.calidusId) {
  draftBody.calidusDeclaration = { calidusId: fixture.calidusId };
  console.log(`[castVote] attaching calidusDeclaration=${fixture.calidusId.slice(0, 16)}…`);
}
const draftRes = await fetch(`${backend}/api/v1/votes/${flags.ballotId}/draft`, {
  method: "POST",
  headers,
  body: JSON.stringify(draftBody),
});
const draft = await draftRes.json().catch(() => ({}));
if (!draftRes.ok || draft.status !== "success") {
  console.error("/draft failed:", JSON.stringify(draft, null, 2));
  process.exit(1);
}
console.log(`  packageId=${draft.package.id} nonce=${draft.package.nonce}`);

// Hydra expects the voter to sign the UTF-8 bytes of the 64-char
// merkleRoot hex string (see hydra-sdk verify-signature.js:38). The
// backend /draft response returns the merkleRoot to sign.
const messageToSign = draft.merkleRoot;
if (!messageToSign) {
  console.error("/draft response missing merkleRoot — is the broker up to date?");
  process.exit(1);
}
console.log(`[castVote] signing merkleRoot=${messageToSign.slice(0, 16)}… via cardano-signer (${skeyPath})`);
const witness = await signCose(messageToSign, skeyPath, voterId);
console.log(`  key=${witness.key?.slice(0, 16)}…`);

// Submit the signature — triggers inline submission to Hydra.
console.log(`[castVote] POST /api/v1/votes/${flags.ballotId}/signature`);
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
console.log(`[castVote] submitted=${sig.submitted}`);
console.log(`  status=${sig.package?.status}`);
console.log(`  hydraTxId=${sig.package?.hydraTxId}`);
console.log(`  ipfsCid=${sig.package?.ipfsCid}`);
console.log(`  confirmedAt=${sig.package?.confirmedAt}`);
process.exit(0);
