// Cast a randomised full-ballot vote on behalf of any fixture voter
// (single-sig DRep, SPO via calidus key, or multisig DRep). Fetches the
// proposals from Mongo, generates a method-appropriate random selection
// per proposal, and submits a single vote package carrying one answer
// per question — which is the contract Hydra/broker expects (one signed
// merkleRoot per voter per nonce).
//
// Usage:
//   node __scripts/vote/castRandomBallot.js --ballotId <id> --voter drep01
//   node __scripts/vote/castRandomBallot.js --ballotId <id> --voter multisig
//   node __scripts/vote/castRandomBallot.js --ballotId <id> --voter calidus02
//
// Flags:
//   --ballotId   required
//   --voter      fixture name in VOTERS_BY_NAME (default: drep01)
//   --seed       optional integer — deterministic PRNG seed for
//                reproducible random selections (default: Math.random)
//   --skeyPath   override fixture.keyPath for single-sig voters
//   --backend    backend base URL (default http://localhost:$SERVER_PORT, or :3000)
//   --multisigCount  number of cosigners to sign with (default: fixture.nativeScript.required)
//   --abstainRate    float in [0,1]; per-question probability of abstain
//                    (only applied when the proposal has requireAnswer !== true).
//                    Default: 0 (full participation).

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { parseArgs } from "../scaffold/common/env.js";
import { loadLocalOverrides } from "../../helper/envOverlay.js";
import { VOTERS_BY_NAME, SINGLE_SIG_VOTER } from "../scaffold/common/fixtures.js";
import { signCose } from "../scaffold/common/coseSign.js";
import { connectToDatabase, disconnectFromDatabase } from "../../helper/dbManager.js";
import { Proposal } from "../../schema/Proposal.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(repoRoot, `.env.${envName}`) });
loadLocalOverrides(repoRoot);

const { flags } = parseArgs();
if (!flags.ballotId) { console.error("Missing --ballotId"); process.exit(1); }

const voterName = flags.voter || "drep01";
const fixture = VOTERS_BY_NAME[voterName];
if (!fixture) { console.error(`Unknown voter fixture: ${voterName}`); process.exit(1); }
const voterId = fixture.userId;
const backend = flags.backend || `http://localhost:${process.env.SERVER_PORT || 3000}`;
const abstainRate = Number(flags.abstainRate) || 0;

// Tiny deterministic PRNG (mulberry32) for reproducible --seed runs; falls
// through to Math.random when no seed is supplied. Inline to avoid a dep.
function makeRng(seed) {
  if (seed === undefined || seed === null || seed === "") {
    return Math.random;
  }
  let s = Number(seed) >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(flags.seed);
function randInt(min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
function pickOne(arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate one valid VoteSelection for a proposal based on its voteType.
 * Returns either `{questionId, abstain: true}` (abstainRate-gated on
 * non-required proposals) or `{questionId, selection: [...]}`.
 */
function randomAnswerFor(proposal) {
  const questionId = proposal._id.toString();
  const requireAnswer = proposal.requireAnswer === true;
  if (!requireAnswer && rng() < abstainRate) {
    return { questionId, abstain: true };
  }
  const optionIds = (proposal.voteOptions || []).map((o) => Number(o.id));
  switch (proposal.voteType) {
    case "choice": {
      return { questionId, selection: [pickOne(optionIds)] };
    }
    case "multi-choice": {
      const min = Number.isFinite(Number(proposal.minSelections)) ? Number(proposal.minSelections) : 1;
      const max = Number.isFinite(Number(proposal.maxSelections)) ? Number(proposal.maxSelections) : optionIds.length;
      const n = randInt(min, max);
      return { questionId, selection: shuffle(optionIds).slice(0, n) };
    }
    case "ranked": {
      return { questionId, selection: shuffle(optionIds) };
    }
    case "scale": {
      // Pick any option id — they encode the grid anchors directly.
      return { questionId, selection: [pickOne(optionIds)] };
    }
    case "likert": {
      const { min = 1, max = 5, step = 1 } = proposal.ratingRange || {};
      const steps = Math.floor((max - min) / step);
      const selection = optionIds.map((option) => {
        const k = randInt(0, steps);
        return { option, value: min + k * step };
      });
      return { questionId, selection };
    }
    case "weighted": {
      // Distribute voterBudget integer points across options. Rough
      // uniform-random partition: hand one point at a time to a random
      // option until the budget is exhausted.
      const budget = Number(proposal.voterBudget) || 100;
      const alloc = new Map(optionIds.map((id) => [id, 0]));
      for (let i = 0; i < budget; i++) {
        const id = pickOne(optionIds);
        alloc.set(id, alloc.get(id) + 1);
      }
      const selection = [...alloc.entries()].map(([option, value]) => ({ option, value }));
      return { questionId, selection };
    }
    case "budget": {
      // Subset whose summed option.cost ≤ voterBudget. We don't have
      // per-option cost here without reading voteOptions in full, so
      // fall back to a random 1..N subset.
      const n = randInt(1, optionIds.length);
      return { questionId, selection: shuffle(optionIds).slice(0, n) };
    }
    default: {
      // Fallback: pick one option id.
      return { questionId, selection: [pickOne(optionIds)] };
    }
  }
}

await connectToDatabase();
const proposals = await Proposal.find({ ballotId: flags.ballotId }).sort({ order: 1 }).lean();
await disconnectFromDatabase();
if (proposals.length === 0) {
  console.error(`No proposals found for ballot ${flags.ballotId}`);
  process.exit(1);
}

const votes = proposals.map(randomAnswerFor);
console.log(`[cast-random] voter=${voterName} (${voterId.slice(0, 32)}…)`);
console.log(`[cast-random] generated ${votes.length} answers across proposals:`);
for (const v of votes) {
  const summary = v.abstain ? "ABSTAIN" : JSON.stringify(v.selection);
  console.log(`  ${v.questionId}  ${summary}`);
}

// Mint JWT — multisig voters get multiSig:true so the broker's session
// handling routes correctly.
const secret = process.env.JWT_SECRET;
if (!secret) { console.error("JWT_SECRET missing"); process.exit(1); }
const isScript = fixture.kind === "script";
const voterJwt = jwt.sign(
  { userId: voterId, signType: "stake", multiSig: isScript },
  secret,
  { expiresIn: process.env.JWT_MAX_AGE || "1h" }
);
const headers = { cookie: `token=${voterJwt}`, "content-type": "application/json" };

// Build the draft body. calidusDeclaration for CIP-151 hot-key voters;
// nativeScript for multisig voters.
const draftBody = { votes };
if (fixture.calidusId) {
  draftBody.calidusDeclaration = { calidusId: fixture.calidusId };
  console.log(`[cast-random] attaching calidusDeclaration=${fixture.calidusId.slice(0, 16)}…`);
}
if (isScript) {
  draftBody.nativeScript = fixture.nativeScript;
}

console.log(`[cast-random] POST /api/v1/votes/${flags.ballotId}/draft`);
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

const messageToSign = draft.merkleRoot;
if (!messageToSign) {
  console.error("/draft response missing merkleRoot — is the broker up to date?");
  process.exit(1);
}
console.log(`[cast-random] merkleRoot=${messageToSign.slice(0, 16)}… (covers all ${votes.length} answers)`);

async function postSignature(witness) {
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
  return sig;
}

if (isScript) {
  const keyPaths = fixture.keyPaths || [];
  const required = Number(fixture.nativeScript?.required || keyPaths.length);
  const count = Math.min(Number(flags.multisigCount) || required, keyPaths.length);
  for (let i = 0; i < count; i++) {
    const skey = keyPaths[i];
    console.log(`[cast-random] multisig cosigner ${i + 1}/${count} signing with ${skey}`);
    const witness = await signCose(messageToSign, skey, voterId);
    console.log(`  key=${witness.key?.slice(0, 16)}…`);
    const sig = await postSignature(witness);
    if (sig.submitted) {
      console.log(`[cast-random] threshold met — submitted to Hydra`);
      console.log(`  hydraTxId=${sig.package?.hydraTxId}`);
      console.log(`  ipfsCid=${sig.package?.ipfsCid}`);
    } else {
      const m = sig.multisig || {};
      console.log(`  awaiting more signatures (outstanding=${m.outstandingKeys?.length ?? "?"})`);
    }
  }
} else {
  const skeyPath = flags.skeyPath || fixture.keyPath || SINGLE_SIG_VOTER.keyPath;
  if (!skeyPath) {
    console.error(`Voter ${voterName} has no keyPath; pass --skeyPath explicitly`);
    process.exit(1);
  }
  console.log(`[cast-random] signing with ${skeyPath}`);
  const witness = await signCose(messageToSign, skeyPath, voterId);
  console.log(`  key=${witness.key?.slice(0, 16)}…`);
  const sig = await postSignature(witness);
  console.log(`[cast-random] submitted=${sig.submitted}`);
  console.log(`  hydraTxId=${sig.package?.hydraTxId}`);
  console.log(`  ipfsCid=${sig.package?.ipfsCid}`);
}
process.exit(0);
