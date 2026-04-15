// Deterministic Ballot + Proposal factory shared by all scaffolds.
//
// Given a descriptor, builds the date window from the requested state
// (upcoming/live/closed) and upserts a Ballot keyed by title so repeat
// runs converge instead of duplicating.

import { Ballot } from "../../../schema/Ballot.js";
import { Proposal } from "../../../schema/Proposal.js";

// Each flavor declares (a) which on-chain validation script applies and
// (b) which voter groups the scaffold should validate in UserCache when
// seeding a ballot with that flavor. The seeder uses `eligibleGroups`
// to decide who can vote; Ballot.voterType is display-only.
//
// Groups correspond to VOTERS[*].voterGroup in ./fixtures.js:
//   "drep"    — DReps
//   "pool"    — SPOs
//   "default" — Stakeholders
const VALIDATION_SCRIPTS = {
  // Single-group flavors
  dreps: {
    script: "voterValidationDReps.js",
    voterType: "DReps",
    startup: "startupBallot.js",
    eligibleGroups: ["drep"],
  },
  stake: {
    script: "voterValidationStake.js",
    voterType: "Stake",
    startup: "startupBallot.js",
    eligibleGroups: ["default"],
  },
  poolPledge: {
    script: "voterValidationPoolsPledge.js",
    voterType: "SPOs (Pledge based)",
    startup: "startupPledgeBasedVoting.js",
    eligibleGroups: ["pool"],
  },
  poolStake: {
    script: "voterValidationPoolsStake.js",
    voterType: "SPOs (Stake based)",
    startup: "startupStakeBasedVoting.js",
    eligibleGroups: ["pool"],
  },
  alwaysTrue: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "All Voters",
    startup: "startupBallot.js",
    eligibleGroups: ["drep", "pool", "default"],
  },
  // Combined-group flavors — scaffold-only. The real voter-validation
  // scripts don't natively take unions; these rely on alwaysTrue +
  // UserCache seeding to gate eligibility. Display strings make the
  // combination explicit.
  drepsPools: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "DReps + SPOs",
    startup: "startupBallot.js",
    eligibleGroups: ["drep", "pool"],
  },
  drepsStake: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "DReps + Stakeholders",
    startup: "startupBallot.js",
    eligibleGroups: ["drep", "default"],
  },
  poolsStake: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "SPOs + Stakeholders",
    startup: "startupBallot.js",
    eligibleGroups: ["pool", "default"],
  },
  allGroups: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "DReps + SPOs + Stakeholders",
    startup: "startupBallot.js",
    eligibleGroups: ["drep", "pool", "default"],
  },
};

export { VALIDATION_SCRIPTS };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Minimum buffer between "now" and the voting window open. Hydra's minting
// policy is timelocked `before(votingOpenSlot)` — once that slot is reached
// the policy is permanently locked and `/prepare` cannot mint the ballot
// tokens. 4 minutes leaves enough time for the prepare tx to confirm on-chain
// before the window opens.
const HYDRA_PREPARE_BUFFER_MS = 4 * MINUTE;

/**
 * Compute vote period bounds for a given state.
 *
 * @param {"upcoming"|"live"|"closed"} state
 * @param {"legacy"|"hydra"} [source="legacy"] — Hydra ballots must have a
 *   future votePeriodStart (timelock requirement) so `live` gets a short
 *   buffer instead of a past start, and `closed` is rejected.
 */
function windowForState(state, source = "legacy", simulated = false, now = Date.now()) {
  switch (state) {
    case "upcoming":
      return { votePeriodStart: new Date(now + 1 * DAY), votePeriodEnd: new Date(now + 8 * DAY) };
    case "live":
      // Legacy can back-date to pretend the ballot is already running;
      // real Hydra must keep the window ahead of the mint tx
      // confirmation. Simulated Hydra ballots never hit the chain, so
      // they can back-date like legacy.
      return source === "hydra" && !simulated
        ? { votePeriodStart: new Date(now + HYDRA_PREPARE_BUFFER_MS), votePeriodEnd: new Date(now + 7 * DAY) }
        : { votePeriodStart: new Date(now - 1 * DAY), votePeriodEnd: new Date(now + 6 * DAY) };
    case "closed":
      if (source === "hydra" && !simulated) {
        throw new Error(
          "Cannot scaffold a 'closed' Hydra ballot without simulated:true — the mint-policy timelock requires votePeriodStart to be in the future at /prepare time. Run the full lifecycle (prepare → start → close/finalize) to produce a real closed Hydra ballot, or pass simulated:true for a fake archive row."
        );
      }
      return { votePeriodStart: new Date(now - 14 * DAY), votePeriodEnd: new Date(now - 7 * DAY) };
    default:
      throw new Error(`Unknown ballot state: ${state}`);
  }
}

/**
 * Produce deterministic, plausible on-chain-looking identifiers for a
 * simulated Hydra ballot. Keyed off the ballot title so repeat runs
 * converge. These never hit the chain — they exist purely so closed
 * Hydra archive rows render in the UI with the same shape as real ones.
 */
import crypto from "node:crypto";
function simulatedHydraIds(title) {
  const h = crypto.createHash("sha256").update(title).digest("hex");
  // Policy IDs are 28 bytes (56 hex chars).
  const policyId = h.slice(0, 56);
  // Asset names share the 28-byte ballot fingerprint prefix.
  const fingerprint = h.slice(0, 56);
  // CIP-30 head IDs are typically 32 bytes hex.
  const headId = h.slice(0, 64);
  // IPFS CIDv1 lookalike. Not a valid base32-encoded CID but enough for
  // display. Real CIDs start with `bafy...`.
  const cid = `bafy${h.slice(0, 46)}`;
  // Cardano tx hashes are 32 bytes hex.
  const txHash = h.slice(8, 72).padEnd(64, "0").slice(0, 64);
  return {
    hydraEndpoint: `https://simulated.hydra.scaffold/${h.slice(0, 8)}`,
    hydraHeadId: headId,
    hydraHeadStatus: "Final",
    ballotCid: cid,
    instancePolicyId: policyId,
    definitionAssetName: `${fingerprint.slice(0, 28)}363030`, // +600 suffix
    instanceAssetName: `${fingerprint.slice(0, 28)}363031`,   // +601 suffix
    prepareTxHash: txHash,
    ballotFingerprint: fingerprint,
  };
}

function defaultProposals(ballotId) {
  return [
    {
      ballotId,
      title: "Default Proposal: Yes/No/Abstain",
      description: "A default proposal with a yes/no/abstain vote.",
      abstainAllowed: true,
      voteType: "default",
      voteBudget: 1,
      voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
      ],
    },
    {
      ballotId,
      title: "Scale Proposal",
      description: "A scale proposal from -100 to 100, step 1, abstain allowed.",
      abstainAllowed: true,
      voteType: "scale",
      voteIncrement: 1,
      voteOptions: [
        { id: -100, label: "-100", cost: 1 },
        { id: 0, label: "0", cost: 1 },
        { id: 100, label: "100", cost: 1 },
      ],
    },
  ];
}

/**
 * Upsert a scaffolded ballot. Returns the Ballot document.
 *
 * @param {Object} opts
 * @param {"legacy"|"hydra"} opts.source
 * @param {"upcoming"|"live"|"closed"} opts.state
 * @param {keyof typeof VALIDATION_SCRIPTS} [opts.flavor="dreps"]
 * @param {number} [opts.index=1]   disambiguator baked into the title for determinism
 * @param {string} [opts.titlePrefix]
 */
export async function upsertScaffoldBallot({
  source,
  state,
  flavor = "dreps",
  index = 1,
  titlePrefix = "Scaffold",
  provisionalResultsEnabled = false,
  simulated = false,
}) {
  const flavorCfg = VALIDATION_SCRIPTS[flavor];
  if (!flavorCfg) throw new Error(`Unknown validation flavor: ${flavor}`);

  const title = `${titlePrefix}/${source}/${flavor}/${state}#${String(index).padStart(3, "0")}`;
  const window = windowForState(state, source, simulated);

  const setFields = {
    title,
    description: `Scaffolded ${source} ballot (${flavor}, ${state}).`,
    voterType: flavorCfg.voterType,
    voterDescription: `Scaffold voters — ${flavor}`,
    voteWeighted: true,
    voteFilters: true,
    voteAuthorityId: `scaffold-authority`,
    voteAuthorityAddress: `scaffold-address`,
    voterValidationScript: flavorCfg.script,
    rollupScript: "rollupBallot.js",
    startupScript: flavorCfg.startup,
    status: state,
    source,
    provisionalResultsEnabled,
  };

  // Window handling — the voting window becomes mint-policy-anchored once
  // /prepare succeeds (hydraEndpoint set). Until then it's safe to refresh
  // on each run so `live` ballots don't end up with a stale past start if
  // the first attempt failed.
  const existing = await Ballot.findOne({ title }).lean();
  const anchored = Boolean(existing?.hydraEndpoint);
  if (!anchored) {
    setFields.votePeriodStart = window.votePeriodStart;
    setFields.votePeriodEnd = window.votePeriodEnd;
  }

  const setOnInsertFields = {
    proposalPeriodStart: new Date(Date.now() - 30 * DAY),
    proposalPeriodEnd: new Date(Date.now() - 15 * DAY),
  };

  // Simulated Hydra closed ballots — stamp deterministic, on-chain-
  // looking IDs so the UX renders like a real archived Hydra ballot.
  // These are scaffold-only; nothing ever hit a chain.
  if (simulated && source === "hydra") {
    Object.assign(setFields, simulatedHydraIds(title));
  }

  const ballot = await Ballot.findOneAndUpdate(
    { title },
    { $set: setFields, $setOnInsert: setOnInsertFields },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Proposals: upsert-by-title-within-ballot for idempotence.
  for (const p of defaultProposals(ballot._id)) {
    await Proposal.updateOne(
      { ballotId: ballot._id, title: p.title },
      { $set: p },
      { upsert: true }
    );
  }

  return ballot;
}
