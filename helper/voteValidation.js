// Backend-side vote validation for the Hydra /draft endpoint.
//
// Hydra middleware is root-of-trust for per-method shape checks at /vote
// submission (see .claude/trds/HYDRA_VOTE_VALIDATION.md for the upstream
// contract). This helper is a friendly pre-flight so voters get 400s
// immediately instead of round-tripping to Hydra for known-bad payloads
// — and covers the one thing Hydra does not natively enforce: the
// knapsack cost-cap on our `budget` voteType (which maps to Hydra
// `multi-choice`).
//
// Intentionally accepts what Hydra accepts. Don't add stricter checks
// here than Hydra — divergence would cause silently-accepted drafts
// that Hydra later rejects at /vote (no user-visible error path).

import { Proposal } from "../schema/Proposal.js";

export class VoteValidationError extends Error {
  constructor(message, { code, path } = {}) {
    super(message);
    this.name = "VoteValidationError";
    this.code = code || "BAD_INPUT";
    this.path = path;
  }
}

function err(message, path) {
  throw new VoteValidationError(message, { path });
}

function isInt(n) {
  return Number.isInteger(n);
}

/**
 * Validate a VoteSelection[] against the proposals on a ballot.
 *
 * @param {Array} votes — VoteSelection[] from the request body.
 * @param {Array} proposals — Proposal docs (lean() is fine) for the ballot.
 * @throws {VoteValidationError} on any shape / constraint violation.
 */
export function validateVoteSelections(votes, proposals) {
  if (!Array.isArray(votes) || votes.length === 0) {
    err("votes[] required", "votes");
  }
  const byId = new Map(proposals.map((p) => [String(p._id), p]));
  const seenQuestions = new Set();

  for (let i = 0; i < votes.length; i++) {
    const v = votes[i];
    const path = `votes[${i}]`;
    if (!v || typeof v !== "object") err("must be an object", path);
    if (!v.questionId) err("questionId required", `${path}.questionId`);

    const qid = String(v.questionId);
    if (seenQuestions.has(qid)) err("duplicate questionId", `${path}.questionId`);
    seenQuestions.add(qid);

    const proposal = byId.get(qid);
    if (!proposal) err("questionId not on this ballot", `${path}.questionId`);

    if (!Array.isArray(v.selection)) {
      err("selection must be an array", `${path}.selection`);
    }

    // Abstain: selection === ["abstain"]. Allowed when the proposal says so.
    if (v.selection.length === 1 && v.selection[0] === "abstain") {
      if (!proposal.abstainAllowed) {
        err("abstain not allowed on this proposal", `${path}.selection`);
      }
      continue;
    }

    validatePerMethod(v.selection, proposal, `${path}.selection`);
  }
}

function validatePerMethod(selection, proposal, path) {
  const optionIds = new Set(
    (proposal.voteOptions || [])
      .filter((o) => o.id !== "abstain")
      .map((o) => Number(o.id))
  );

  switch (proposal.voteType) {
    case "default":
    case "preference":
      validateNumberArray(selection, optionIds, path);
      break;

    case "scale":
      validateNumberArray(selection, null, path);
      if (selection.length !== 1) err("scale expects exactly one value", path);
      validateScaleGrid(selection[0], proposal, path);
      break;

    case "ranked":
      validateNumberArray(selection, optionIds, path);
      if (new Set(selection).size !== selection.length) {
        err("ranked selection must not repeat options", path);
      }
      break;

    case "budget":
      // Knapsack: number[] (multi-choice shape) — Hydra multi-choice
      // enforces [min, max] count bounds; WE enforce Σ cost ≤ voterBudget.
      validateNumberArray(selection, optionIds, path);
      if (new Set(selection).size !== selection.length) {
        err("budget selection must not repeat options", path);
      }
      validateKnapsackCap(selection, proposal, path);
      break;

    case "weighted":
      validateSelectionEntries(selection, optionIds, path);
      validateWeightedSum(selection, proposal, path);
      break;

    case "likert":
      validateSelectionEntries(selection, optionIds, path);
      validateLikertGrid(selection, proposal, path);
      break;

    default:
      err(`unsupported voteType: ${proposal.voteType}`, path);
  }
}

function validateNumberArray(selection, allowedIds, path) {
  for (let i = 0; i < selection.length; i++) {
    const v = selection[i];
    if (!isInt(v)) err("entries must be integers", `${path}[${i}]`);
    if (allowedIds && !allowedIds.has(v)) {
      err(`option ${v} not in voteOptions`, `${path}[${i}]`);
    }
  }
}

function validateSelectionEntries(selection, allowedIds, path) {
  const seen = new Set();
  for (let i = 0; i < selection.length; i++) {
    const e = selection[i];
    if (!e || typeof e !== "object") {
      err("entries must be {option, value}", `${path}[${i}]`);
    }
    if (!isInt(e.option) || !allowedIds.has(e.option)) {
      err(`option ${e.option} not in voteOptions`, `${path}[${i}].option`);
    }
    if (!isInt(e.value) || e.value < 0) {
      err("value must be a non-negative integer", `${path}[${i}].value`);
    }
    if (seen.has(e.option)) {
      err("duplicate option entry", `${path}[${i}].option`);
    }
    seen.add(e.option);
  }
}

function validateKnapsackCap(selection, proposal, path) {
  const costById = new Map(
    (proposal.voteOptions || []).map((o) => [Number(o.id), Number(o.cost) || 0])
  );
  const cap = Number(proposal.voterBudget) || 0;
  let spent = 0;
  for (const id of selection) spent += costById.get(id) || 0;
  if (spent > cap) {
    err(`Σ cost ${spent} exceeds voterBudget ${cap}`, path);
  }
}

function validateWeightedSum(selection, proposal, path) {
  const target = Number(proposal.voterBudget);
  if (!Number.isFinite(target) || target <= 0) {
    err("proposal.voterBudget must be a positive integer", path);
  }
  let sum = 0;
  for (const e of selection) sum += e.value;
  if (sum !== target) {
    err(`Σ value ${sum} must equal voterBudget ${target}`, path);
  }
}

function validateScaleGrid(value, proposal, path) {
  if (!isInt(value)) err("scale value must be an integer", path);
  const ids = (proposal.voteOptions || []).map((o) => Number(o.id));
  if (ids.length === 0) return;
  const min = Math.min(...ids);
  const max = Math.max(...ids);
  const step = Number(proposal.voteIncrement) || 1;
  if (value < min || value > max) {
    err(`value ${value} outside [${min}, ${max}]`, path);
  }
  if (((value - min) % step) !== 0) {
    err(`value ${value} not on step grid (min=${min}, step=${step})`, path);
  }
}

function validateLikertGrid(selection, proposal, path) {
  const range = proposal.ratingRange || { min: 1, max: 5, step: 1 };
  const min = Number(range.min);
  const max = Number(range.max);
  const step = Number(range.step) || 1;
  for (let i = 0; i < selection.length; i++) {
    const v = selection[i].value;
    if (v < min || v > max) {
      err(`rating ${v} outside [${min}, ${max}]`, `${path}[${i}].value`);
    }
    if (((v - min) % step) !== 0) {
      err(`rating ${v} not on step grid (min=${min}, step=${step})`, `${path}[${i}].value`);
    }
  }
  // Likert expects exactly one entry per non-abstain option. Enforce.
  const nonAbstainOptions = (proposal.voteOptions || []).filter((o) => o.id !== "abstain");
  if (selection.length !== nonAbstainOptions.length) {
    err(
      `likert expects one rating per option (${nonAbstainOptions.length}); got ${selection.length}`,
      path
    );
  }
}

/**
 * Convenience wrapper — fetches proposals for a ballot and validates in
 * one call. Returns { ok, errors? } to keep the route handler flat.
 */
export async function validateVotesForBallot(votes, ballotId) {
  const proposals = await Proposal.find({ ballotId }).lean();
  try {
    validateVoteSelections(votes, proposals);
    return { ok: true };
  } catch (e) {
    if (e instanceof VoteValidationError) {
      return { ok: false, error: { code: e.code, message: e.message, path: e.path } };
    }
    throw e;
  }
}
