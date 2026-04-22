// RSS v2 incentive ballot — DRAFT, rebuilt against the current schema.
//
// Supersedes __scripts/createIncentiveVote.js (kept for reference). Uses:
//   • voterGroups for heterogeneous power sources:
//       DReps   → StakeBased  (delegated voting power)
//       Pools   → PledgeBased (pool pledge)
//   • voteType "choice" for Yes/No questions (items 1, 3)
//   • voteType "likert" with a 1-5 step-1 ratingRange for MJ questions
//     (items 2, 4, 5)
//   • abstain permitted everywhere (requireAnswer not set)
//   • rich per-question data.referenceLinks + data.bindingOn (UI-only,
//     backend metadata — NOT committed by contentHash)
//   • blake2b_256 contentHash stamped on every proposal post-insert via
//     ensureProposalContentHashes, committed into Hydra's
//     ekklesia.merkleRoot once /prepare runs.
//
// Usage:
//   node __scripts/createIncentiveBallot.v2.js              # dry-run: Mongo only
//   node __scripts/createIncentiveBallot.v2.js --prepare    # dry-run + Hydra /prepare
//   node __scripts/createIncentiveBallot.v2.js --prepare --endpoint https://…
//   node __scripts/createIncentiveBallot.v2.js --voteStartMinutes 60 --voteDurationDays 7
//
// Flags:
//   --prepare             After Mongo insert, call Hydra /prepare with the
//                         built BallotDefinition. Requires HYDRA_DEFAULT_ENDPOINT
//                         or --endpoint. (Hydra /prepare is NOT idempotent —
//                         re-running mints fresh tokens.)
//   --endpoint URL        Override HYDRA_DEFAULT_ENDPOINT.
//   --voteStartMinutes N  Minutes from now until voting opens. Default 15.
//                         Hydra mint-policy requires > ~4 minutes ahead.
//   --voteDurationMinutes N  Window length in minutes — takes precedence
//                            over --voteDurationDays. Useful for same-day
//                            E2E test runs.
//   --voteDurationDays N  Length of voting window in days. Default 1.
//   --authority ADDRESS   bech32 voting-authority address. Defaults to a
//                         placeholder; MUST be set for a real preprod run.
//   --title STRING        Override the ballot title (useful for dry-runs).
//
// Exits non-zero on any failure. The Mongo insert happens BEFORE the
// /prepare call, so if Hydra rejects the body the ballot doc still
// exists — delete manually or rerun to re-prepare after fixing.

import process from "process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import {
  connectToDatabase,
  disconnectFromDatabase,
} from "../helper/dbManager.js";
import { loadLocalOverrides } from "../helper/envOverlay.js";
import { ensureProposalContentHashes } from "../helper/proposalContent.js";
import { buildPrepareBody } from "./scaffold/common/hydraPrepare.js";
import { forEndpoint, HydraClientError } from "../helper/hydraClient.js";

// ---------------------------------------------------------------------
// Bootstrap env
// ---------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envName = process.env.NODE_ENV || "development";
dotenv.config({ path: join(__dirname, "..", `.env.${envName}`) });
loadLocalOverrides(join(__dirname, ".."));

// ---------------------------------------------------------------------
// Flag parsing (minimal; no extra deps)
// ---------------------------------------------------------------------
// Supports both `--flag=value` and `--flag value`. Argument without a
// leading `--` is consumed as the preceding flag's value.
const flags = {};
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else {
      const key = raw.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
}
const doPrepare = flags.prepare === true || flags.prepare === "true";
const endpointOverride = typeof flags.endpoint === "string" ? flags.endpoint : null;
const voteStartMinutes = Number(flags.voteStartMinutes) || 15;
const voteDurationMinutes = Number(flags.voteDurationMinutes) || null;
const voteDurationDays = Number(flags.voteDurationDays) || 1;
const authorityAddress =
  typeof flags.authority === "string"
    ? flags.authority
    : "addr_test1_PLACEHOLDER_REPLACE_FOR_REAL_RUNS";
const titleOverride = typeof flags.title === "string" ? flags.title : null;

// ---------------------------------------------------------------------
// Ballot content
// ---------------------------------------------------------------------

// Default title for dry runs. Stamp the current date so the ballot is
// unambiguously test content on preprod explorers — community members
// watching preprod traffic shouldn't mistake it for a real vote.
function defaultTitle() {
  const today = new Date().toISOString().slice(0, 10);
  return `Ekklesia Dry Run ${today}`;
}
const BALLOT_TITLE = titleOverride || defaultTitle();
const BALLOT_DESCRIPTION =
  "Ballot organized by the Cardano Incentives Working Group (CIWG), an " +
  "independent volunteer collective of community members researching " +
  "improvements to Cardano's Reward Sharing Scheme (RSS). This ballot " +
  "collects community signal on proposed incentive changes and initial " +
  "parameter values for potential inclusion in a future hard fork.\n\n" +
  "Cardano DReps vote using their delegated voting power, SPOs vote " +
  "using their pledge. An entity with both a DRep credential AND an " +
  "operator pledge has each portion counted separately, by design.\n\n" +
  "**More info:**\n" +
  "- https://cerkoryn.gitbook.io/rssv2/\n" +
  "- https://incentives.solutions";

const VOTER_DESCRIPTION =
  "Eligible: Cardano DReps (vote by delegated voting power) and SPOs " +
  "(vote by pool pledge). Snapshot taken at voting-period end. If an " +
  "entity is registered as both a DRep and an SPO, both portions count " +
  "toward their vote (intentional).";

// voteType "likert" for the three MJ questions. 1-5 integer grid.
const LIKERT_RANGE = { min: 1, max: 5, step: 1 };
const LIKERT_LABELS = { 1: "Least Preferred", 5: "Most Preferred" };
const LIKERT_TIE_BREAKERS = [
  "Higher share of weight above the median wins.",
  "Lower share of weight below the median wins.",
  "Higher parameter value wins (authority-resolved; not computed by tally).",
];

/**
 * RSS v2 proposal definitions. IDs on options start at 1 per proposal
 * and are stable across reruns (the script is idempotent at the
 * Proposal title level — re-runs upsert in place and contentHash
 * gets re-stamped).
 */
function buildProposalDocs(ballotId) {
  return [
    {
      ballotId,
      title: "1) Adopt CIP-50 — Pledge Leverage-Based Staking Rewards",
      summary:
        "Introduces a new parameter L to cap a pool's effective stake " +
        "relative to its pledge, discouraging highly under-pledged / " +
        "split pools and aiming to improve sybil resistance and " +
        "decentralization without penalizing well-pledged small pools.",
      rationale: null,
      authors: [{ name: "Cardano Incentives Working Group" }],
      version: "v1.0",
      voteType: "choice",
      voteOptions: [
        { id: 1, label: "Yes" },
        { id: 2, label: "No" },
      ],
      data: {
        bindsItems: ["rss-v2-item-2"],
        passCondition:
          "YES voting weight > NO voting weight; abstain:true excluded from tally.",
        referenceLinks: [
          { label: "CIP-50 text", url: "https://cips.cardano.org/cip/CIP-50" },
          { label: "CIP-50 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1042" },
          { label: "Cardano Forum discussion", url: "https://forum.cardano.org/t/cip-0050-pledge-leverage-based-staking-rewards" },
          { label: "RSS Simulation Engine PR", url: "https://github.com/Blockchain-Technology-Lab/Rewards-Sharing-Simulation-Engine/pull/11" },
          { label: "Foundation Table Talk (video)", url: "https://www.youtube.com/live/dGymb5wCX8Y" },
          { label: "Parameter Committee slides", url: "https://docs.google.com/presentation/d/1foroY6UjFRyCicKE8QkrOpDgqS5_NrS-qN6u6HHhWHA" },
          { label: "CIP-50 modeling tool", url: "https://spo-incentives.vercel.app" },
          { label: "CIP-50 FAQ", url: "https://incentives.solutions/cip-50-faq" },
        ],
      },
      externalProposal: { id: "rss-v2-item-1", url: "https://cips.cardano.org/cip/CIP-50" },
    },
    {
      ballotId,
      title: "2) Initial value of the CIP-50 \"L\" parameter",
      summary:
        "L is a new protocol parameter that represents a pool's pledge " +
        "leverage (stake-to-pledge ratio) used when computing a pool's " +
        "eligible stake in rewards. Stake above L × pledge is treated " +
        "as oversaturated and does not contribute additional rewards.",
      rationale:
        "Example: if L is set to 1000 and a pool has 10k ADA in pledge, " +
        "that pool can support up to 10M ADA in stake (1000 × 10k) " +
        "before becoming oversaturated. If that pool increased their " +
        "pledge to 100k, that would amount to 100M ADA in stake " +
        "(1000 × 100k) — but at that point they would be limited by " +
        "the global saturation cap set by the k parameter, which is " +
        "currently around 71.7M ADA.",
      authors: [{ name: "Cardano Incentives Working Group" }],
      version: "v1.0",
      voteType: "likert",
      ratingRange: LIKERT_RANGE,
      voteOptions: [
        { id: 1, label: "Greater than 2500" },
        { id: 2, label: "2500" },
        { id: 3, label: "2000" },
        { id: 4, label: "1000" },
        { id: 5, label: "750" },
        { id: 6, label: "500" },
        { id: 7, label: "Less than 500" },
      ],
      data: {
        tallyRule: "majority-judgment",
        ratingLabels: LIKERT_LABELS,
        tieBreakers: LIKERT_TIE_BREAKERS,
        bindingOn: "rss-v2-item-1",
        nonSpecificAnswerFallback:
          "If a greater/less-than option wins, a statistical analysis " +
          "may be conducted to determine the initial value, or a " +
          "follow-up ballot may be run.",
        referenceLinks: [
          { label: "CIP-50 modeling tool", url: "https://spo-incentives.vercel.app/" },
          { label: "L-values chart (2025-10-15 snapshot)", url: "https://raw.githubusercontent.com/Cerkoryn/governance-reference/refs/heads/main/L_values.png" },
        ],
      },
      externalProposal: { id: "rss-v2-item-2", url: "https://cips.cardano.org/cip/CIP-50" },
    },
    {
      ballotId,
      title: "3) Adopt CIP-163 — Time-Bound Delegation with Dynamic Rewards",
      summary:
        "Introduces a delegatorInactivity parameter (epochs) as " +
        "proof-of-life for each delegating wallet. Inactive wallets " +
        "don't earn rewards or contribute voting power until " +
        "reactivated. Full rewards pot is distributed among eligible " +
        "participants rather than partially returned to the reserve.",
      rationale: null,
      authors: [{ name: "Cardano Incentives Working Group" }],
      version: "v1.0",
      voteType: "choice",
      voteOptions: [
        { id: 1, label: "Yes" },
        { id: 2, label: "No" },
      ],
      data: {
        bindsItems: ["rss-v2-item-4"],
        passCondition:
          "YES voting weight > NO voting weight; abstain:true excluded from tally.",
        referenceLinks: [
          { label: "CIP-163 text", url: "https://cips.cardano.org/cip/CIP-163" },
          { label: "CIP-163 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1077" },
          { label: "Cardano Forum discussion", url: "https://forum.cardano.org/t/cip-0163-time-bound-delegation-with-dynamic-rewards" },
          { label: "Foundation seminar (video)", url: "https://youtu.be/zxcuOqHe7zA" },
          { label: "Seminar slides", url: "https://docs.google.com/presentation/d/1m_s0yymahQjyE21s1VgC6CgYC0K4mjP2YgjnIGzUhNo" },
          { label: "CIP-163 modeling tool", url: "https://spo-incentives.vercel.app" },
          { label: "CIP-163 FAQ", url: "https://incentives.solutions/cip-163-faq/" },
        ],
      },
      externalProposal: { id: "rss-v2-item-3", url: "https://cips.cardano.org/cip/CIP-163" },
    },
    {
      ballotId,
      title: "4) Initial value of the CIP-163 \"delegatorInactivity\" parameter",
      summary:
        "delegatorInactivity is the number of epochs a wallet may go " +
        "without a transaction before becoming ineligible for rewards " +
        "and governance. Any stake-credential witness refreshes the " +
        "duration. Applied retroactively.",
      rationale: null,
      authors: [{ name: "Cardano Incentives Working Group" }],
      version: "v1.0",
      voteType: "likert",
      ratingRange: LIKERT_RANGE,
      voteOptions: [
        { id: 1, label: "Less than 146 epochs (2 years)" },
        { id: 2, label: "146 epochs (2 years)" },
        { id: 3, label: "219 epochs (3 years)" },
        { id: 4, label: "292 epochs (4 years)" },
        { id: 5, label: "365 epochs (5 years)" },
        { id: 6, label: "438 epochs (6 years)" },
        { id: 7, label: "Greater than 438 epochs (6 years)" },
      ],
      data: {
        tallyRule: "majority-judgment",
        ratingLabels: LIKERT_LABELS,
        tieBreakers: LIKERT_TIE_BREAKERS,
        bindingOn: "rss-v2-item-3",
        notes: [
          "6 years is a viable choice, but the oldest delegations won't " +
            "be that old until 2026-07-29 (Shelley anniversary); 0 ADA " +
            "/ 0 wallets affected until then.",
        ],
        referenceLinks: [
          { label: "CIP-163 modeling tool", url: "https://spo-incentives.vercel.app" },
          { label: "Inactive stake-by-pool search", url: "https://earncoinpool.com/CIP-163.html" },
          { label: "delegatorInactivity values chart (2025-10-15)", url: "https://raw.githubusercontent.com/Cerkoryn/governance-reference/refs/heads/main/delegatorInactivity_values.jpg" },
        ],
      },
      externalProposal: { id: "rss-v2-item-4", url: "https://cips.cardano.org/cip/CIP-163" },
    },
    {
      ballotId,
      title: "5) Initial value of the CIP-23 \"minPoolMargin\" parameter",
      summary:
        "Introduces minPoolMargin, the minimum variable fee a pool can " +
        "set. Intended to complement minPoolCost to make fees fairer " +
        "for delegators to smaller pools and reduce centralization " +
        "pressure. Does NOT eliminate minPoolCost.",
      rationale: null,
      authors: [{ name: "Cardano Incentives Working Group" }],
      version: "v1.0",
      voteType: "likert",
      ratingRange: LIKERT_RANGE,
      voteOptions: [
        { id: 1, label: "0%" },
        { id: 2, label: "1%" },
        { id: 3, label: "2%" },
        { id: 4, label: "3%" },
        { id: 5, label: "5%" },
        { id: 6, label: "Greater than 5%" },
      ],
      data: {
        tallyRule: "majority-judgment",
        ratingLabels: LIKERT_LABELS,
        tieBreakers: LIKERT_TIE_BREAKERS,
        notes: ["Introduces minPoolMargin but does NOT eliminate minPoolCost."],
        referenceLinks: [
          { label: "CIP-23 text", url: "https://cips.cardano.org/cip/CIP-23" },
          { label: "CIP-23 GitHub Discussion", url: "https://github.com/cardano-foundation/CIPs/pull/1086" },
          { label: "Cardano Forum discussion", url: "https://forum.cardano.org/t/cip-0023-fair-min-fees" },
          { label: "CIP-23 misconceptions", url: "https://incentives.solutions/misconception-pool-min-fee-is-applied-to-all-blocks-in-an-epoch" },
        ],
      },
      externalProposal: { id: "rss-v2-item-5", url: "https://cips.cardano.org/cip/CIP-23" },
    },
  ];
}

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------

await connectToDatabase();

const now = Date.now();
const votePeriodStart = new Date(now + voteStartMinutes * 60 * 1000);
const durationMs = voteDurationMinutes
  ? voteDurationMinutes * 60 * 1000
  : voteDurationDays * 24 * 60 * 60 * 1000;
const votePeriodEnd = new Date(votePeriodStart.getTime() + durationMs);

console.log(`[rss-v2] title:              ${BALLOT_TITLE}`);
console.log(`[rss-v2] votePeriodStart:    ${votePeriodStart.toISOString()}`);
console.log(`[rss-v2] votePeriodEnd:      ${votePeriodEnd.toISOString()}`);
console.log(`[rss-v2] voteAuthorityAddr:  ${authorityAddress}`);
console.log(`[rss-v2] mode:               ${doPrepare ? "prepare" : "dry-run (Mongo only)"}`);
console.log();

// Idempotent at the title level — re-runs update in place (votePeriod fields
// refresh too, so re-running resets the timeline).
const ballot = await Ballot.findOneAndUpdate(
  { title: BALLOT_TITLE },
  {
    $set: {
      title: BALLOT_TITLE,
      description: BALLOT_DESCRIPTION,
      voterType: "any", // closed enum; real eligibility lives in voterGroups
      voterDescription: VOTER_DESCRIPTION,
      voterGroups: [
        { group: "drep", powerSource: "StakeBased" },
        { group: "pool", powerSource: "PledgeBased" },
        // Stake group included for the dry run so a real stake
        // credential on preprod exercises the new Koios/Blockfrost-
        // backed stakeholder validator. Off-spec for the real RSS v2
        // ballot (which is drep + pool only) but appropriate for an
        // Ekklesia Dry Run — exercises all three credential paths.
        {
          group: "stake",
          powerSource: "StakeBased",
          requirements: { mustExist: true },
        },
      ],
      voteWeighted: true,
      voteFilters: false,
      votePeriodStart,
      votePeriodEnd,
      voteAuthorityId: "ciwg",
      voteAuthorityAddress: authorityAddress,
      proposalPeriodStart: new Date(now - 7 * 24 * 60 * 60 * 1000),
      proposalPeriodEnd: new Date(now),
      // Lazy validation: no startup pre-seed of all DReps/pools. The
      // dispatcher in voterValidationByCredential.js routes each
      // arriving voter to the right per-group Koios lookup at /draft
      // time. Pre-seeding doesn't scale (a stake ballot could be
      // millions of rows) and is also wasteful — only voters who
      // actually show up to vote need to be validated.
      voterValidationScript: "voterValidationByCredential.js",
      rollupScript: "rollupBallot.js",
      startupScript: "startupBallot.js",
      status: "upcoming",
      source: "hydra",
    },
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);
console.log(`[rss-v2] ballot _id:         ${ballot._id}`);

// Proposals: upsert-by-title-within-ballot for idempotence.
for (const p of buildProposalDocs(ballot._id)) {
  await Proposal.updateOne(
    { ballotId: ballot._id, title: p.title },
    { $set: p },
    { upsert: true }
  );
}
const proposalCount = await Proposal.countDocuments({ ballotId: ballot._id });
console.log(`[rss-v2] proposals upserted: ${proposalCount}`);

// Stamp contentHash on every proposal. Runs after the upserts so the
// hash reflects the final committed content.
const stamped = await ensureProposalContentHashes(ballot._id);
console.log(`[rss-v2] contentHash stamps: ${stamped} proposal(s) updated`);

// ---------------------------------------------------------------------
// Optional: call Hydra /prepare
// ---------------------------------------------------------------------
if (doPrepare) {
  const endpoint = endpointOverride || process.env.HYDRA_DEFAULT_ENDPOINT;
  if (!endpoint) {
    console.error(
      "[rss-v2] --prepare requires --endpoint=<url> or HYDRA_DEFAULT_ENDPOINT in env."
    );
    await disconnectFromDatabase();
    process.exit(2);
  }
  try {
    const client = forEndpoint(endpoint);
    const body = await buildPrepareBody(ballot, {
      votingAuthority: authorityAddress,
    });
    console.log(`[rss-v2] calling ${endpoint}/prepare — namespace=${body.namespace}`);
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
    if (data?.ekklesia?.merkleRoot) ballot.ekklesiaMerkleRoot = data.ekklesia.merkleRoot;
    await ballot.save();

    const network = (process.env.NETWORK_NAME || "preprod").toLowerCase();
    const explorer =
      network === "mainnet"
        ? `https://cexplorer.io/tx/${ballot.prepareTxHash}`
        : `https://preprod.cexplorer.io/tx/${ballot.prepareTxHash}`;

    console.log(`[rss-v2] prepared`);
    console.log(`  hydraEndpoint    = ${ballot.hydraEndpoint}`);
    console.log(`  prepareTxHash    = ${ballot.prepareTxHash || "(not returned)"}`);
    console.log(`  explorer         = ${ballot.prepareTxHash ? explorer : "-"}`);
    console.log(`  ballotCid        = ${ballot.ballotCid}`);
    console.log(`  instancePolicyId = ${ballot.instancePolicyId}`);
    console.log(`  hydraHeadId      = ${ballot.hydraHeadId || "(set on /start)"}`);
    console.log(`  ekklesiaMerkleRoot = ${ballot.ekklesiaMerkleRoot || "(not returned)"}`);
    console.log();
    console.log(`export BALLOT='${ballot._id}'`);
  } catch (err) {
    if (err instanceof HydraClientError) {
      console.error(
        `[rss-v2] Hydra /prepare failed: ${err.message}` +
          (err.data ? `\n  upstream: ${JSON.stringify(err.data)}` : "")
      );
      console.error(
        "\n  /prepare is NOT idempotent — it mints fresh tokens and spends\n" +
          "  admin wallet UTxOs on every call. Before retrying, confirm no\n" +
          "  tokens were actually minted and/or sweep the admin address."
      );
    } else {
      console.error(`[rss-v2] unexpected error: ${err.stack || err.message}`);
    }
    process.exitCode = 1;
  }
} else {
  console.log();
  console.log("[rss-v2] dry-run complete. To submit against Hydra:");
  console.log(`  node __scripts/createIncentiveBallot.v2.js --prepare`);
  console.log("");
  console.log("# Inspect the Hydra request body without submitting:");
  console.log(`  node -e "import('./__scripts/scaffold/common/hydraPrepare.js').then(async m => { const {Ballot}=await import('./schema/Ballot.js'); const b=await Ballot.findById('${ballot._id}'); console.log(JSON.stringify(await m.buildPrepareBody(b), null, 2)); })"`);
}

await disconnectFromDatabase();
process.exit(process.exitCode || 0);
