// Deterministic vote + result seeder for scaffolded ballots.
//
// Given a ballot, its proposals, and the voters eligible for it, this
// produces a plausible tally so the UI can render live and closed
// ballots with populated results. Keyed off ballotId+userId+proposalId
// so repeat runs converge — no duplicate Vote rows and the same
// percentages come back out.
//
// State semantics:
//   closed   — full turnout. Result.source = "final". finalizedAt = now.
//   live     — ~60% turnout (deterministic per voter). Result.source = "provisional".
//   upcoming — no votes, no results (noop).
//
// Scope: scaffold use only. Does NOT talk to Hydra. For real Hydra
// rollups see crons/10minAggregateVotes.js.

import crypto from "node:crypto";
import { Vote } from "../../../schema/Vote.js";
import { Result } from "../../../schema/Result.js";
import {
  turnoutForBallot,
  participates,
} from "./votingPowerDistribution.js";
import {
  computeBallotParticipation,
  computeProposalParticipation,
  computeParticipatingAbstainers,
} from "../../../helper/results/ballotParticipation.js";
import { computeScaleStats, bucketScaleSamplesByGroup } from "../../../helper/results/scaleStats.js";
import { computeRankedDistribution } from "../../../helper/results/rankedDistribution.js";
import { computeLikertStats, bucketLikertVotesByGroup } from "../../../helper/results/likertStats.js";
import { computeWeightedStats, bucketWeightedVotesByGroup } from "../../../helper/results/weightedStats.js";

/**
 * Stable 0..1 pseudo-random per (ballot, user, proposal, salt). Using
 * SHA-256 of the concatenation so repeat runs produce identical values.
 */
function prand(ballotId, userId, proposalId, salt = "") {
  const h = crypto
    .createHash("sha256")
    .update(`${ballotId}|${userId}|${proposalId}|${salt}`)
    .digest();
  const n = h.readUInt32BE(0);
  return n / 0xffffffff;
}

/**
 * Per-ballot Yes/No/Abstain skew so archives don't all look the same.
 *   yesMargin in [0.20, 0.85] — some ballots pass, some fail, some contested
 *   abstainRate in [0.02, 0.18]
 */
function defaultSkew(ballotId) {
  const a = prand(ballotId, "__skew", "yes");
  const b = prand(ballotId, "__skew", "abstain");
  return {
    yesMargin: 0.2 + a * 0.65,
    abstainRate: 0.02 + b * 0.16,
  };
}

function pickOption(proposal, r, ballotId) {
  const opts = Array.isArray(proposal.voteOptions) ? proposal.voteOptions : [];
  if (opts.length === 0) return null;

  if (proposal.voteType === "choice" && opts.length === 2) {
    const { yesMargin, abstainRate } = defaultSkew(ballotId);
    if (proposal.requireAnswer !== true && r < abstainRate) return ["abstain"];
    // After abstain bucket, normalize r into [0, 1) for the Yes/No
    // split so the skew percentages stay accurate.
    const r2 = (r - (proposal.requireAnswer !== true ? abstainRate : 0)) /
      (1 - (proposal.requireAnswer !== true ? abstainRate : 0));
    return [r2 < yesMargin ? opts[0].id : opts[1].id];
  }

  if (proposal.voteType === "scale") {
    if (proposal.requireAnswer !== true && r < 0.06) return ["abstain"];
    // Spread votes across the FULL [min, max] range, snapped to the
    // declared increment — declared anchor points (e.g. -100/0/100)
    // are just the legal range boundaries, not the only legal votes.
    // Without spreading, the histogram would have all votes stacked
    // on three columns.
    const numericIds = opts.map((o) => Number(o.id)).filter((n) => Number.isFinite(n));
    const min = Math.min(...numericIds);
    const max = Math.max(...numericIds);
    const inc = Number(proposal.voteIncrement) || 1;
    // Use a per-ballot Gaussian-ish skew so different scale proposals
    // look distinct rather than all uniform.
    const skewCenter = min + (max - min) * (0.3 + 0.4 * prand(ballotId, "scale", "center"));
    // Box-Muller-ish: average two uniforms → triangular distribution
    // centered on skewCenter.
    const r2 = prand(ballotId, "scale", "second_" + r.toFixed(8));
    const triangular = (r + r2) / 2; // [0, 1)
    const span = max - min;
    const drift = (triangular - 0.5) * span; // [-span/2, +span/2)
    let value = skewCenter + drift;
    if (value < min) value = min;
    if (value > max) value = max;
    // Snap to increment grid.
    value = Math.round(value / inc) * inc;
    return [value];
  }
  if (proposal.voteType === "ranked") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    // Random permutation of option ids, deterministic per (proposal, voter).
    const ids = opts.map((o) => o.id).filter((id) => id !== "abstain");
    const sorted = ids
      .map((id, i) => ({ id, sort: prand(ballotId, "ranked", `${id}_${i}_${r.toFixed(8)}`) }))
      .sort((a, b) => a.sort - b.sort)
      .map((x) => x.id);
    // Some voters only rank a subset (random truncation [1, full]).
    const depth = Math.max(1, Math.ceil(r * sorted.length));
    return sorted.slice(0, depth);
  }
  if (proposal.voteType === "likert") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    const range = proposal.ratingRange || { min: 1, max: 5, step: 1 };
    const step = Number(range.step) || 1;
    const steps = Math.floor((range.max - range.min) / step) + 1;
    const opts = proposal.voteOptions?.filter((o) => o.id !== "abstain") || [];
    // Hydra v2 unified shape: {option, value} — value = rating snapped
    // to the ratingRange grid. Matches the wire format the backend
    // sends on /draft, so Vote.vote mirrors Hydra's selection[].
    return opts.map((o) => ({
      option: o.id,
      value:
        range.min +
        Math.floor(prand(ballotId, `likert_${o.id}`, r.toFixed(8)) * steps) *
          step,
    }));
  }
  if (proposal.voteType === "multi-choice") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    // Pick minSelections..maxSelections selections, deterministic per
    // (proposal, voter, r). Popularity skew differs per option so the
    // tally doesn't come out flat.
    const ids = opts.map((o) => o.id).filter((id) => id !== "abstain");
    const min = Number.isFinite(Number(proposal.minSelections))
      ? Math.max(1, Number(proposal.minSelections))
      : 1;
    const max = Number.isFinite(Number(proposal.maxSelections))
      ? Math.min(Number(proposal.maxSelections), ids.length)
      : ids.length;
    const ranked = ids
      .map((id, i) => ({ id, sort: prand(ballotId, "multi-choice", `${id}_${i}_${r.toFixed(8)}`) }))
      .sort((a, b) => a.sort - b.sort)
      .map((x) => x.id);
    const n = pickInt(ballotId, r, min, Math.max(min, max));
    return ranked.slice(0, n);
  }
  if (proposal.voteType === "budget") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    // Knapsack: pick options whose summed `cost` ≤ voterBudget. Emits
    // number[] (multi-choice shape) — matches Hydra method:"multi-choice".
    const budget = Number(proposal.voterBudget) || 1;
    const ids = opts.map((o) => o.id).filter((id) => id !== "abstain");
    const ranked = ids
      .map((id, i) => ({ id, sort: prand(ballotId, "budget", `${id}_${i}_${r.toFixed(8)}`) }))
      .sort((a, b) => a.sort - b.sort);
    const out = [];
    let used = 0;
    for (const { id } of ranked) {
      const opt = opts.find((o) => o.id === id);
      const cost = Number(opt?.cost) || 1;
      if (used + cost > budget) continue;
      out.push(id);
      used += cost;
    }
    return out.length > 0 ? out : [ranked[0].id];
  }
  if (proposal.voteType === "weighted") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    // Point allocation: distribute voterBudget integer points across
    // options with deterministic per-option popularity skew. Emits
    // [{option, value}] summing EXACTLY to voterBudget — matches
    // Hydra method:"weighted". Uses largest-remainder rounding so the
    // sum lands precisely even when pure weighting would round off.
    const budget = Math.max(1, Math.floor(Number(proposal.voterBudget) || 100));
    const ids = opts.map((o) => o.id).filter((id) => id !== "abstain");
    const weights = ids.map((id) =>
      0.1 + prand(ballotId, "weighted", `${id}_${r.toFixed(8)}`) * 0.9
    );
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const raw = weights.map((w) => (w / totalWeight) * budget);
    const floors = raw.map((v) => Math.floor(v));
    let remainder = budget - floors.reduce((s, v) => s + v, 0);
    // Distribute the remainder to options with the largest fractional parts.
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    const final = floors.slice();
    for (let k = 0; k < remainder; k++) {
      final[order[k % order.length].i] += 1;
    }
    // Emit one entry per option (zero-value entries included) so the
    // wire shape is uniform and Σ value === voterBudget is obvious
    // across all voters.
    return ids.map((id, i) => ({ option: id, value: final[i] }));
  }
  // Fallthrough for voteType:"choice" with ≥3 options (e.g. the CC
  // election with 7 candidates). Pick exactly one, weighted by a
  // per-option popularity coefficient so the tally isn't uniform.
  if (proposal.voteType === "choice") {
    if (proposal.requireAnswer !== true && r < 0.05) return ["abstain"];
    const ids = opts.map((o) => o.id).filter((id) => id !== "abstain");
    const weights = ids.map((id) => 1 + prand(ballotId, "popularity", id) * 4);
    const sum = weights.reduce((s, w) => s + w, 0);
    let target = r * sum;
    for (let i = 0; i < ids.length; i++) {
      target -= weights[i];
      if (target <= 0) return [ids[i]];
    }
    return [ids[ids.length - 1]];
  }
  return [opts[Math.floor(r * opts.length)].id];
}

function pickInt(ballotId, salt, min, max) {
  const r = prand(ballotId, "pickInt", String(salt));
  return Math.floor(r * (max - min + 1)) + min;
}

/**
 * Aggregate a set of votes into the Result shape the app expects.
 *
 * @returns {{ results: Array, totalVotes: number,
 *             resultsByGroup: Object }}
 */
function rollup(proposal, votes, votersByUserId, ballot) {
  const isScale = proposal.voteType === "scale";
  const isRanked = proposal.voteType === "ranked";
  const isLikert = proposal.voteType === "likert";
  const isWeighted = proposal.voteType === "weighted";
  const isDiscrete = !isScale && !isRanked && !isLikert && !isWeighted;

  const optionRow = (opt) => ({
    id: opt.id,
    label: opt.label,
    count: 0,
    votingPower: 0,
  });
  const abstainRow = () => ({
    id: "abstain",
    label: "Abstain",
    count: 0,
    votingPower: 0,
  });
  const makeTally = () => {
    if (!isDiscrete) {
      // Scale/ranked don't have a meaningful per-option discrete tally;
      // emit an abstain row only (when allowed) so the existing
      // frontend code path doesn't choke on an empty array.
      return proposal.requireAnswer !== true ? [abstainRow()] : [];
    }
    const rows = proposal.voteOptions.map(optionRow);
    if (proposal.requireAnswer !== true) rows.push(abstainRow());
    return rows;
  };

  const byGroup = new Map(); // group → { results, totalVotes }
  const overall = makeTally();
  let totalOverall = 0;

  for (const v of votes) {
    const voter = votersByUserId.get(v.userId);
    if (!voter) continue;
    const power = voter.votingPower ?? 1;
    const group = voter.voterGroup || "stake";

    if (!byGroup.has(group)) {
      byGroup.set(group, { results: makeTally(), totalVotes: 0 });
    }
    const g = byGroup.get(group);

    if (isDiscrete) {
      const targets = Array.isArray(v.vote) ? v.vote : [v.vote];
      for (const t of targets) {
        const row = overall.find((r) => r.id === t);
        const gRow = g.results.find((r) => r.id === t);
        if (!row || !gRow) continue;
        row.count += 1;
        row.votingPower += power;
        gRow.count += 1;
        gRow.votingPower += power;
        totalOverall += 1;
        g.totalVotes += 1;
      }
    } else {
      // For scale/ranked, totalVotes counts voters (not per-target votes).
      // Abstain still goes to the abstain row.
      const first = Array.isArray(v.vote) ? v.vote[0] : v.vote;
      if (first === "abstain") {
        const ar = overall.find((r) => r.id === "abstain");
        const gar = g.results.find((r) => r.id === "abstain");
        if (ar) { ar.count += 1; ar.votingPower += power; }
        if (gar) { gar.count += 1; gar.votingPower += power; }
      }
      totalOverall += 1;
      g.totalVotes += 1;
    }
  }

  const resultsByGroup = {};
  for (const [group, payload] of byGroup.entries()) {
    resultsByGroup[group] = payload;
  }

  // Per-vote-type augmentations: scale stats, ranked distribution.
  if (isScale) {
    const samplesByGroup = bucketScaleSamplesByGroup(votes, votersByUserId);
    for (const [group, samples] of samplesByGroup.entries()) {
      if (!resultsByGroup[group]) continue;
      resultsByGroup[group].scale = computeScaleStats({
        proposal,
        samples,
        voteWeighted: !!ballot?.voteWeighted,
      });
    }
  } else if (isRanked) {
    const distByGroup = computeRankedDistribution({
      proposal,
      votes,
      votersByUserId,
    });
    for (const [group, dist] of distByGroup.entries()) {
      if (!resultsByGroup[group]) continue;
      resultsByGroup[group].ranked = dist;
    }
  } else if (isLikert) {
    const votesByGroup = bucketLikertVotesByGroup(votes, votersByUserId);
    for (const [group, groupVotes] of votesByGroup.entries()) {
      if (!resultsByGroup[group]) continue;
      resultsByGroup[group].likert = computeLikertStats({
        proposal,
        votes: groupVotes,
        votersByUserId,
        voteWeighted: !!ballot?.voteWeighted,
      });
    }
  } else if (isWeighted) {
    const votesByGroup = bucketWeightedVotesByGroup(votes, votersByUserId);
    for (const [group, groupVotes] of votesByGroup.entries()) {
      if (!resultsByGroup[group]) continue;
      resultsByGroup[group].weighted = computeWeightedStats({
        proposal,
        votes: groupVotes,
        votersByUserId,
        voteWeighted: !!ballot?.voteWeighted,
      });
    }
  }

  return {
    results: overall,
    totalVotes: totalOverall,
    resultsByGroup,
  };
}

/**
 * Seed votes + result for a single proposal.
 *
 * @param {Object} ballot     Ballot document (needs _id, source, status)
 * @param {Object} proposal   Proposal document (needs _id, voteType, voteOptions, requireAnswer)
 * @param {Array} voters     Voter objects from VOTERS fixture (needs userId, voterGroup, votingPower)
 * @param {"closed"|"live"|"upcoming"} state
 */
async function seedProposal(ballot, proposal, voters, state) {
  if (state === "upcoming") return { votes: 0, result: null };

  // Per-ballot turnout — varies so Active/Total ratios look different
  // across the demo set. Closed ballots end up roughly 60-95%; live
  // somewhere in 20-70%.
  const turnout = turnoutForBallot(ballot._id.toString(), state);

  // Clear prior Vote docs for this proposal so re-runs converge
  // exactly. Without this, voters who participated in a prior run but
  // get filtered out by the new turnout draw leave orphan rows that
  // the live API would still count even though our seeded Result
  // ignores them.
  await Vote.deleteMany({ proposalId: proposal._id });

  const now = new Date();
  // Spread submittedAt across a plausible window so the UI can render
  // "recent activity" timelines. Closed ballots get times in the past.
  const windowEnd =
    state === "closed"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      : now;
  const windowStart =
    state === "closed"
      ? new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
      : new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const cast = [];
  // Per-proposal engagement among ballot-participating voters: not
  // every voter touches every question. ~75-90% of ballot-active
  // voters engage with any given proposal — the remainder is
  // skipped/abstained-by-omission. Deterministic per
  // (proposal, voter) so re-runs converge.
  const proposalEngagement = 0.75 + prand(ballot._id.toString(), proposal._id.toString(), "engagement") * 0.15;
  for (const voter of voters) {
    // `forceParticipate` lets a fixture voter bypass the random
    // turnout draw — used for the frontend voter-history test subject
    // so they always have votes on every eligible ballot. Same voter
    // still skips per-proposal engagement below to produce a realistic
    // "voted on most but not all questions" shape.
    const forced = voter.forceParticipate === true;
    if (!forced && !participates(ballot._id.toString(), voter.userId, turnout)) {
      continue;
    }
    const e = prand(ballot._id.toString(), voter.userId, proposal._id.toString(), "engage");
    if (!forced && e > proposalEngagement) continue;
    const r = prand(ballot._id.toString(), voter.userId, proposal._id.toString(), "pick");
    const vote = pickOption(proposal, r, ballot._id.toString());
    if (!vote) continue;

    const tOffset = prand(ballot._id.toString(), voter.userId, proposal._id.toString(), "t");
    const submittedAt = new Date(
      windowStart.getTime() + tOffset * (windowEnd.getTime() - windowStart.getTime())
    );

    await Vote.updateOne(
      { proposalId: proposal._id, userId: voter.userId },
      {
        $set: {
          ballotId: ballot._id,
          vote,
          submittedVote: vote,
          submittedAt,
        },
      },
      { upsert: true }
    );
    cast.push({ userId: voter.userId, vote });
  }

  const votersByUserId = new Map(voters.map((v) => [v.userId, v]));
  const tally = rollup(proposal, cast, votersByUserId, ballot);
  const [ballotParticipation, proposalParticipation, participatingAbstainers] =
    await Promise.all([
      computeBallotParticipation(ballot._id),
      computeProposalParticipation(proposal._id, ballot._id),
      computeParticipatingAbstainers(proposal._id, ballot._id),
    ]);

  // Reconcile per-group totalVotes with distinct voter counts. The
  // discrete rollup increments totalVotes per vote target, which
  // over-counts ranked + budget. proposalParticipation.voterCount
  // is the canonical distinct-voter count; same fix as the cron.
  for (const groupKey of Object.keys(tally.resultsByGroup)) {
    const distinct = proposalParticipation.voterCount?.[groupKey];
    if (typeof distinct === "number") {
      tally.resultsByGroup[groupKey].totalVotes = distinct;
    }
  }

  const resultDoc = {
    proposalId: proposal._id,
    ballotId: ballot._id,
    ballotSource: ballot.source || "legacy",
    results: tally.results,
    resultsByGroup: tally.resultsByGroup,
    ballotParticipation,
    proposalParticipation,
    participatingAbstainers,
    source: state === "closed" ? "final" : "provisional",
    finalizedAt: state === "closed" ? now : null,
  };

  await Result.updateOne(
    { proposalId: proposal._id },
    { $set: resultDoc },
    { upsert: true }
  );

  return { votes: cast.length, result: resultDoc };
}

/**
 * Seed votes + results across every proposal on a ballot.
 *
 * @returns {Promise<{ totalVotes: number, proposalsSeeded: number }>}
 */
export async function seedBallotVotes({ ballot, proposals, voters, state }) {
  if (state === "upcoming" || !Array.isArray(proposals) || proposals.length === 0) {
    return { totalVotes: 0, proposalsSeeded: 0 };
  }
  let totalVotes = 0;
  let proposalsSeeded = 0;
  for (const p of proposals) {
    const { votes } = await seedProposal(ballot, p, voters, state);
    totalVotes += votes;
    proposalsSeeded += 1;
  }
  return { totalVotes, proposalsSeeded };
}
