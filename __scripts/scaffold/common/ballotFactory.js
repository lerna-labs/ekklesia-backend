// Deterministic Ballot + Proposal factory shared by all scaffolds.
//
// Given a descriptor, builds the date window from the requested state
// (upcoming/live/closed) and upserts a Ballot keyed by title so repeat
// runs converge instead of duplicating.

import { Ballot } from "../../../schema/Ballot.js";
import { Proposal } from "../../../schema/Proposal.js";

const VALIDATION_SCRIPTS = {
  dreps: { script: "voterValidationDReps.js", voterType: "DReps", startup: "startupBallot.js" },
  stake: { script: "voterValidationStake.js", voterType: "Stake", startup: "startupBallot.js" },
  poolPledge: {
    script: "voterValidationPoolsPledge.js",
    voterType: "SPOs (Pledge based)",
    startup: "startupPledgeBasedVoting.js",
  },
  poolStake: {
    script: "voterValidationPoolsStake.js",
    voterType: "SPOs (Stake based)",
    startup: "startupStakeBasedVoting.js",
  },
  alwaysTrue: {
    script: "voterValidationAlwaysTrue.js",
    voterType: "Stake",
    startup: "startupBallot.js",
  },
};

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
function windowForState(state, source = "legacy", now = Date.now()) {
  switch (state) {
    case "upcoming":
      return { votePeriodStart: new Date(now + 1 * DAY), votePeriodEnd: new Date(now + 8 * DAY) };
    case "live":
      // Legacy can back-date to pretend the ballot is already running;
      // Hydra must keep the window ahead of the mint tx confirmation.
      return source === "hydra"
        ? { votePeriodStart: new Date(now + HYDRA_PREPARE_BUFFER_MS), votePeriodEnd: new Date(now + 7 * DAY) }
        : { votePeriodStart: new Date(now - 1 * DAY), votePeriodEnd: new Date(now + 6 * DAY) };
    case "closed":
      if (source === "hydra") {
        throw new Error(
          "Cannot scaffold a 'closed' Hydra ballot: the mint-policy timelock requires votePeriodStart to be in the future at /prepare time. Run the full lifecycle (prepare → start → close/finalize) to produce a closed Hydra ballot, or use source=legacy for a pre-closed archive row."
        );
      }
      return { votePeriodStart: new Date(now - 14 * DAY), votePeriodEnd: new Date(now - 7 * DAY) };
    default:
      throw new Error(`Unknown ballot state: ${state}`);
  }
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
}) {
  const flavorCfg = VALIDATION_SCRIPTS[flavor];
  if (!flavorCfg) throw new Error(`Unknown validation flavor: ${flavor}`);

  const title = `${titlePrefix}/${source}/${flavor}/${state}#${String(index).padStart(3, "0")}`;
  const window = windowForState(state, source);

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
