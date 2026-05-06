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
import { epochForDate } from "../../../helper/cardanoEpochs.js";

/**
 * Stable namespace string derived from the ballot title.
 * Format: vote.ekklesia.<slug>
 *
 * Operator-curated namespaces (e.g. for a public production ballot)
 * should be passed explicitly to buildPrepareBody via opts.namespace
 * rather than inferred from the title, since title-derived slugs
 * bake punctuation and phrasing into the on-chain identifier.
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
    // requireAnswer (Hydra field, default false = abstain allowed).
    // Backend and Hydra use the same field name and polarity now —
    // pass through verbatim. Abstaining voters submit
    // { questionId, abstain: true }; Hydra routes them to the tally's
    // abstainedByRole counter. Distinct from "include an Abstain
    // option among the voteOptions" — those selections end up in the
    // per-option tally.
    requireAnswer: proposal.requireAnswer === true,
    // blake2b_256 of the canonical per-proposal content blob. Hydra
    // accepts this optional field on BallotQuestion (per the
    // HYDRA_PROPOSAL_CONTENT_HASH TRD, landed upstream 2026-04-20)
    // and folds it into `ekklesia.merkleRoot`, committing voter-
    // facing content (descriptions, images, option metadata) on-
    // chain. undefined when absent so canonicalization doesn't emit
    // the key and ballots without a computed hash still validate.
    contentHash: proposal.contentHash || undefined,
  };

  switch (proposal.voteType) {
    case "choice": {
      // Single-pick. Exactly one option selected per voter. Hydra
      // distinguishes binary (2 options) from single-choice (≥3) at
      // the method level; both accept `selection: [optId]`.
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
    case "multi-choice": {
      // Pick min..max from a list. Uses the proposal's explicit
      // minSelections / maxSelections when set; otherwise defaults to
      // 1 and options.length respectively. Hydra's `multi-choice`
      // method only enforces count bounds — no cost awareness (see
      // `budget` voteType for knapsack semantics).
      const options = (proposal.voteOptions || []).map((o) => ({
        label: o.label,
        value: Number(o.id),
      }));
      const min = Number.isFinite(Number(proposal.minSelections))
        ? Number(proposal.minSelections)
        : 1;
      const max = Number.isFinite(Number(proposal.maxSelections))
        ? Number(proposal.maxSelections)
        : options.length;
      return {
        ...base,
        method: "multi-choice",
        options,
        minSelections: min,
        maxSelections: max,
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
 * Build the CIP-179 `roleWeighting` object for Hydra's /prepare body.
 *
 * Prefers `ballot.voterGroups[]` (the authoritative declaration). When
 * voterGroups is empty/absent, falls back to the legacy voterType
 * display-string inference so pre-voterGroups ballots keep working.
 */
function roleWeightingFor(ballot) {
  const groups = Array.isArray(ballot?.voterGroups) ? ballot.voterGroups : [];
  if (groups.length > 0) {
    const out = {};
    for (const g of groups) {
      if (!g?.group || !g?.powerSource) continue;
      out[g.group] = g.powerSource;
    }
    if (Object.keys(out).length > 0) return out;
  }
  // Legacy fallback — infer role + power source from the voterType
  // display string. Keeps hand-curated ballots without voterGroups
  // importable during the migration window.
  const v = (ballot?.voterType || "").toLowerCase();
  if (v.includes("drep")) return { drep: "StakeBased" };
  if (v.includes("pledge")) return { pool: "PledgeBased" };
  if (v.includes("spo") || v.includes("pool")) return { pool: "StakeBased" };
  return { stake: "StakeBased" };
}

/**
 * Build the bech32-HRP list accepted as voter credentials for this
 * ballot. Derived from voterGroups when present; legacy voterType
 * inference otherwise. `pool`-eligible ballots also accept `calidus`
 * (hot-key representation of the same SPO).
 */
function acceptedCredentialsFor(ballot) {
  const groups = Array.isArray(ballot?.voterGroups) ? ballot.voterGroups : [];
  if (groups.length > 0) {
    const out = new Set();
    for (const g of groups) {
      if (g?.group === "drep") out.add("drep");
      else if (g?.group === "pool") { out.add("pool"); out.add("calidus"); }
      else if (g?.group === "stake") out.add("stake");
    }
    if (out.size > 0) return [...out];
  }
  const v = (ballot?.voterType || "").toLowerCase();
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
 * @param {number} [opts.gasAmount=5] — ADA on the (601) instance-token UTxO.
 *   In-head txs use `.setFee('0')`, so the (601) only needs enough above
 *   minUTxO (~1.3 ADA) to satisfy the ledger. Matches the 5-ADA sibling
 *   outputs produced by /prepare and keeps (601) off the "largest UTxO"
 *   list so the hydra-node's coin selection won't pick it for InitTx
 *   seed/collateral. See HYDRA_DEDICATED_FUEL_WALLET.md TRD.
 */
export async function buildPrepareBody(ballot, opts = {}) {
  const proposals = await Proposal.find({ ballotId: ballot._id }).lean();
  if (proposals.length === 0) {
    throw new Error(`Ballot ${ballot._id} has no proposals to publish`);
  }

  const namespace = opts.namespace || namespaceForTitle(ballot.title);
  // Cardano epoch numbers are network-anchored (Shelley genesis), and
  // epoch length differs across networks (preview = 1d, preprod/mainnet
  // = 5d). Resolve via Koios /tip + /genesis instead of dividing Unix
  // time by a hardcoded 5-day window. See helper/cardanoEpochs.js.
  const endEpoch = await epochForDate(ballot.votePeriodEnd);

  const ballotDef = {
    specVersion: "ekklesia/1.0",
    title: ballot.title,
    description: ballot.description,
    questions: proposals.map(proposalToQuestion),
    roleWeighting: roleWeightingFor(ballot),
    endEpoch,
    ekklesia: {
      namespace,
      votingAuthority: opts.votingAuthority || ballot.voteAuthorityAddress || "",
      context: "hydra-head",
      acceptedCredentials: acceptedCredentialsFor(ballot),
      merkleRoot: "", // filled by Hydra
      votingWindow: {
        open: new Date(ballot.votePeriodStart).toISOString(),
        close: new Date(ballot.votePeriodEnd).toISOString(),
      },
    },
  };

  return {
    namespace,
    ballot: ballotDef,
    gasAmount: opts.gasAmount ?? 5,
  };
}
