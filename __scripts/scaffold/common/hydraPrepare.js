// Build a Hydra `/prepare` request body from a local Ballot + its Proposals.
// Hydra expects:
//   {
//     namespace: string,
//     ballot: BallotDefinition  // CIP-179 core + ekklesia extension
//   }
//
// See ~/ekklesia/hydra/src/types.ts (BallotDefinition, BallotQuestion,
// EkklesiaBallotExtension) — the source of truth for this shape.

import { Proposal } from "../../../schema/Proposal.js";

/**
 * Stable namespace string derived from the ballot title.
 * Format: vote.ekklesia.scaffold.<slug>
 */
export function namespaceForTitle(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `vote.ekklesia.${slug}`;
}

/**
 * Map a local Proposal document to a Hydra BallotQuestion.
 */
function proposalToQuestion(proposal) {
  const base = {
    questionId: proposal._id.toString(),
    question: proposal.title,
    // Hydra's BallotQuestion `description` field is the short voter-
    // facing blurb — map from Proposal.summary now that the legacy
    // top-level description field has been dropped.
    description: proposal.summary || "",
    // Hydra uses `requireAnswer` (default false = abstain allowed).
    // Our internal Proposal.abstainAllowed has inverted polarity —
    // translate at the wire boundary. Only proposals that explicitly
    // set `abstainAllowed: false` force an answer.
    //
    // Abstaining voters submit { questionId, abstain: true }; Hydra
    // routes them to the tally's abstainedByRole counter. Distinct
    // from "include an Abstain option among the voteOptions" — those
    // selections end up in the per-option tally.
    requireAnswer: proposal.abstainAllowed === false,
  };

  switch (proposal.voteType) {
    case "default": {
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      return {
        ...base,
        method: options.length === 2 ? "binary" : "single-choice",
        options,
        minSelections: 1,
        maxSelections: 1,
      };
    }
    case "budget": {
      // Knapsack: voter picks a subset whose summed option.cost ≤
      // voterBudget. Maps to Hydra multi-choice — Hydra only enforces
      // [min, max] count bounds. The cost-cap is backend-validated at
      // /draft since Hydra multi-choice has no cost awareness.
      //
      // minSelections is always >= 1 — voters who want to skip submit
      // { abstain: true } instead of an empty selection. Hydra rejects
      // minSelections = 0 at /prepare.
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      return {
        ...base,
        method: "multi-choice",
        options,
        minSelections: 1,
        maxSelections: options.length,
      };
    }
    case "weighted": {
      // Point allocation: voter distributes voterBudget points across
      // options. Σ values must equal voterBudget exactly. Hydra validates
      // shape + sum at /vote time (see HYDRA_VOTE_VALIDATION TRD).
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      return {
        ...base,
        method: "weighted",
        options,
        budget: proposal.voterBudget || 100,
      };
    }
    case "ranked": {
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      return {
        ...base,
        method: "ranked",
        options,
        rankCount: options.length,
      };
    }
    case "scale": {
      const ids = (proposal.voteOptions || []).map((o) => Number(o.id));
      if (ids.length < 2) {
        throw new Error(
          `Scale proposal ${proposal._id} needs at least two options for valueRange`
        );
      }
      const min = Math.min(...ids);
      const max = Math.max(...ids);
      const step = Number(proposal.voteIncrement) || 1;
      return {
        ...base,
        method: "range",
        valueRange: { min, max, step },
      };
    }
    case "likert": {
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      const src = proposal.ratingRange || { min: 1, max: 5 };
      const ratingRange = {
        min: src.min,
        max: src.max,
        step: Number(src.step) || 1,
      };
      return {
        ...base,
        method: "likert",
        options,
        ratingRange,
      };
    }
    default:
      throw new Error(`Unsupported voteType: ${proposal.voteType}`);
  }
}

/**
 * Map a voterType string (e.g. "DReps", "Stake", "SPOs (Pledge based)") into
 * a CIP-179 roleWeighting object. Only include roles that are actually
 * eligible for this ballot — must align with `acceptedCredentialsFor` below.
 */
function roleWeightingFor(voterType) {
  const v = (voterType || "").toLowerCase();
  if (v.includes("drep")) return { DRep: "StakeBased" };
  if (v.includes("pledge")) return { SPO: "PledgeBased" };
  if (v.includes("spo") || v.includes("pool")) return { SPO: "StakeBased" };
  return { Stakeholder: "StakeBased" };
}

/**
 * Map a voterType into bech32 HRPs accepted as voter credentials.
 */
function acceptedCredentialsFor(voterType) {
  const v = (voterType || "").toLowerCase();
  if (v.includes("drep")) return ["drep"];
  if (v.includes("pool") || v.includes("spo") || v.includes("pledge"))
    return ["pool", "calidus"];
  return ["stake"];
}

/**
 * Build the full /prepare request body.
 *
 * @param {object} ballot — local Ballot mongoose doc (or lean object)
 * @param {object} [opts]
 * @param {string} [opts.votingAuthority] — bech32 address (advisory)
 * @param {number} [opts.gasAmount=100]
 */
export async function buildPrepareBody(ballot, opts = {}) {
  const proposals = await Proposal.find({ ballotId: ballot._id }).lean();
  if (proposals.length === 0) {
    throw new Error(`Ballot ${ballot._id} has no proposals to publish`);
  }

  const namespace = namespaceForTitle(ballot.title);
  const endEpoch = Math.floor(new Date(ballot.votePeriodEnd).getTime() / 1000 / (5 * 24 * 60 * 60));

  const ballotDef = {
    specVersion: "ekklesia/1.0",
    title: ballot.title,
    description: ballot.description,
    questions: proposals.map(proposalToQuestion),
    roleWeighting: roleWeightingFor(ballot.voterType),
    endEpoch,
    ekklesia: {
      namespace,
      votingAuthority: opts.votingAuthority || ballot.voteAuthorityAddress || "",
      context: "hydra-head",
      acceptedCredentials: acceptedCredentialsFor(ballot.voterType),
      merkleRoot: "", // filled by Hydra
      ballotIpfsCid: "", // filled by Hydra
      votingWindow: {
        open: new Date(ballot.votePeriodStart).toISOString(),
        close: new Date(ballot.votePeriodEnd).toISOString(),
      },
    },
  };

  return {
    namespace,
    ballot: ballotDef,
    gasAmount: opts.gasAmount ?? 100,
  };
}
