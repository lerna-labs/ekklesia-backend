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

const DAY = 24 * 60 * 60 * 1000;

/**
 * Compute vote period bounds for a given state.
 * upcoming: starts in the future
 * live:     started in the past, ends in the future
 * closed:   ended in the past
 */
function windowForState(state, now = Date.now()) {
  switch (state) {
    case "upcoming":
      return { votePeriodStart: new Date(now + 1 * DAY), votePeriodEnd: new Date(now + 8 * DAY) };
    case "live":
      return { votePeriodStart: new Date(now - 1 * DAY), votePeriodEnd: new Date(now + 6 * DAY) };
    case "closed":
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
  const window = windowForState(state);

  const payload = {
    title,
    description: `Scaffolded ${source} ballot (${flavor}, ${state}).`,
    voterType: flavorCfg.voterType,
    voterDescription: `Scaffold voters — ${flavor}`,
    voteWeighted: true,
    voteFilters: true,
    votePeriodStart: window.votePeriodStart,
    votePeriodEnd: window.votePeriodEnd,
    voteAuthorityId: `scaffold-authority`,
    voteAuthorityAddress: `scaffold-address`,
    proposalPeriodStart: new Date(Date.now() - 30 * DAY),
    proposalPeriodEnd: new Date(Date.now() - 15 * DAY),
    voterValidationScript: flavorCfg.script,
    rollupScript: "rollupBallot.js",
    startupScript: flavorCfg.startup,
    status: state,
    source,
    provisionalResultsEnabled,
  };

  const ballot = await Ballot.findOneAndUpdate({ title }, { $set: payload }, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

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
