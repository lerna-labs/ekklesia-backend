// Derive a full `{ results, resultsByGroup, ballotParticipation, proposalParticipation }`
// tuple for a single proposal from a Hydra `/audit/full` evidence bundle.
//
// The goal is byte-for-byte compatibility with what `crons/10minAggregateVotes.js`
// produces for legacy / provisional-enabled ballots — so the frontend's
// existing `ScaleGroupResult`, `RankedGroupResult`, `LikertGroupResult`, and
// `WeightedGroupResult` components render Hydra-backed final tallies without
// any downstream changes.
//
// All the per-method math is delegated to the existing helpers in
// `helper/results/*.js`; this module's only job is to shape evidence into
// the `{userId, vote}` + `Map<userId, {voterGroup, votingPower}>` inputs
// those helpers already consume.

import {
  bucketScaleSamplesByGroup,
  computeScaleStats,
} from "./scaleStats.js";
import { computeRankedDistribution } from "./rankedDistribution.js";
import {
  bucketLikertVotesByGroup,
  computeLikertStats,
} from "./likertStats.js";
import {
  bucketWeightedVotesByGroup,
  computeWeightedStats,
} from "./weightedStats.js";
import { votesForProposal } from "../hydraEvidence.js";

/**
 * Unwind a per-voter `{userId, vote}` list into per-group option tallies +
 * distinct-voter counts. Mirrors the $unwind + $group aggregation the
 * provisional cron runs against Vote rows.
 *
 * @param {{userId: string, vote: Array}[]} votes
 * @param {Map<string, {voterGroup: string, votingPower: number}>} votersByUserId
 * @returns {Map<string, {
 *   perOption: Map<string|number, {count: number, votingPower: number}>,
 *   distinctVoters: Set<string>,
 * }>}
 */
function groupByVoterGroup(votes, votersByUserId) {
  const byGroup = new Map();
  for (const row of votes) {
    const meta = votersByUserId.get(row.userId);
    if (!meta) continue;
    const group = meta.voterGroup || "default";
    let entry = byGroup.get(group);
    if (!entry) {
      entry = { perOption: new Map(), distinctVoters: new Set() };
      byGroup.set(group, entry);
    }
    entry.distinctVoters.add(row.userId);
    // `vote` is either `["abstain"]` or an array of numeric ids (choice /
    // scale / ranked) or `{option, value}` entries (likert / weighted).
    // For resultsByGroup[].results we count once per option-id appearance,
    // matching the provisional cron's $unwind semantics.
    for (const item of row.vote) {
      const id = item && typeof item === "object" ? item.option : item;
      const rec = entry.perOption.get(id) || { count: 0, votingPower: 0 };
      rec.count += 1;
      rec.votingPower += typeof meta.votingPower === "number" ? meta.votingPower : 1;
      entry.perOption.set(id, rec);
    }
  }
  return byGroup;
}

/**
 * Build the top-level per-proposal `results[]` — aggregated across every
 * voter group. Matches the shape the provisional cron writes to
 * `Result.results` (see `resultsWithLabels` at line 136 of
 * `crons/10minAggregateVotes.js`): one row per `voteOptions` entry plus an
 * `Abstain` row when `requireAnswer !== true`, each with `{id, label,
 * count, votingPower}`.
 *
 * @param {object} proposal
 * @param {{userId: string, vote: Array}[]} votes
 * @param {Map<string, {voterGroup: string, votingPower: number}>} votersByUserId
 */
function deriveTopLevelResults(proposal, votes, votersByUserId) {
  const perOption = new Map();
  for (const row of votes) {
    const meta = votersByUserId.get(row.userId);
    // Skip voters the caller didn't map — matches the per-group bucket's
    // behavior in `groupByVoterGroup`. For the certify path this is how
    // we drop voters the authority flagged ineligible: the caller builds
    // the map with ineligible voters omitted and the tally sees nothing.
    if (!meta) continue;
    const power = typeof meta.votingPower === "number" ? meta.votingPower : 1;
    for (const item of row.vote) {
      const id = item && typeof item === "object" ? item.option : item;
      const rec = perOption.get(id) || { count: 0, votingPower: 0 };
      rec.count += 1;
      rec.votingPower += power;
      perOption.set(id, rec);
    }
  }
  const results = (proposal.voteOptions || []).map((opt) => {
    const hit = perOption.get(opt.id);
    return {
      id: opt.id,
      label: opt.label,
      count: hit?.count || 0,
      votingPower: hit?.votingPower || 0,
    };
  });
  if (proposal.requireAnswer !== true) {
    const abstainHit = perOption.get("abstain");
    results.push({
      id: "abstain",
      label: "Abstain",
      count: abstainHit?.count || 0,
      votingPower: abstainHit?.votingPower || 0,
    });
  }
  return results;
}

/**
 * Build `Result.resultsByGroup` for a single proposal. Matches the
 * provisional cron's output shape — same `results`, `totalVotes`, and
 * per-method extension block on each group.
 *
 * @param {object} args
 * @param {object} args.ballot
 * @param {object} args.proposal
 * @param {{userId: string, vote: Array}[]} args.votes
 * @param {Map<string, {voterGroup: string, votingPower: number}>} args.votersByUserId
 */
function deriveResultsByGroup({ ballot, proposal, votes, votersByUserId }) {
  const grouped = groupByVoterGroup(votes, votersByUserId);
  const resultsByGroup = {};
  const optionLookup = new Map(
    (proposal.voteOptions || []).map((o) => [o.id, o.label])
  );
  for (const [groupKey, bucket] of grouped.entries()) {
    const perGroupResults = (proposal.voteOptions || []).map((opt) => {
      const rec = bucket.perOption.get(opt.id);
      return {
        id: opt.id,
        label: opt.label,
        count: rec?.count || 0,
        votingPower: rec?.votingPower || 0,
      };
    });
    if (proposal.requireAnswer !== true) {
      const abstainRec = bucket.perOption.get("abstain");
      perGroupResults.push({
        id: "abstain",
        label: "Abstain",
        count: abstainRec?.count || 0,
        votingPower: abstainRec?.votingPower || 0,
      });
    }
    // Stamp any option ids that weren't in `voteOptions` (shouldn't happen
    // for well-formed ballots, but keep parity with the provisional cron's
    // permissive label fallback at line 203-208).
    for (const [id, rec] of bucket.perOption.entries()) {
      if (id === "abstain") continue;
      if (optionLookup.has(id)) continue;
      perGroupResults.push({
        id,
        label: String(id),
        count: rec.count,
        votingPower: rec.votingPower,
      });
    }
    resultsByGroup[groupKey] = {
      results: perGroupResults,
      // Distinct-voter count in this group — final authority over the
      // $unwind-inflated count used during assembly. Same reconciliation
      // the provisional cron applies at line 321-326.
      totalVotes: bucket.distinctVoters.size,
    };
  }

  if (["scale", "ranked", "likert", "weighted"].includes(proposal.voteType)) {
    if (proposal.voteType === "scale") {
      const samplesByGroup = bucketScaleSamplesByGroup(votes, votersByUserId);
      for (const [group, samples] of samplesByGroup.entries()) {
        if (!resultsByGroup[group]) continue;
        resultsByGroup[group].scale = computeScaleStats({
          proposal,
          samples,
          voteWeighted: !!ballot.voteWeighted,
        });
      }
    } else if (proposal.voteType === "ranked") {
      const distByGroup = computeRankedDistribution({
        proposal,
        votes,
        votersByUserId,
      });
      for (const [group, dist] of distByGroup.entries()) {
        if (!resultsByGroup[group]) continue;
        resultsByGroup[group].ranked = dist;
      }
    } else if (proposal.voteType === "likert") {
      const votesByGroup = bucketLikertVotesByGroup(votes, votersByUserId);
      for (const [group, groupVotes] of votesByGroup.entries()) {
        if (!resultsByGroup[group]) continue;
        resultsByGroup[group].likert = computeLikertStats({
          proposal,
          votes: groupVotes,
          votersByUserId,
          voteWeighted: !!ballot.voteWeighted,
        });
      }
    } else if (proposal.voteType === "weighted") {
      const votesByGroup = bucketWeightedVotesByGroup(votes, votersByUserId);
      for (const [group, groupVotes] of votesByGroup.entries()) {
        if (!resultsByGroup[group]) continue;
        resultsByGroup[group].weighted = computeWeightedStats({
          proposal,
          votes: groupVotes,
          votersByUserId,
          voteWeighted: !!ballot.voteWeighted,
        });
      }
    }
  }

  return resultsByGroup;
}

/**
 * Ballot-scoped distinct-voter participation derived from evidence. Mirrors
 * `computeBallotParticipation` (which queries Vote rows) but uses the
 * audit bundle directly — Vote rows are not populated for Hydra ballots
 * without `provisionalResultsEnabled`.
 *
 * Rule: a voter is "participating" on the ballot iff they have at least
 * one non-abstain answer across any proposal in the bundle.
 */
function ballotParticipationFromEvidence(auditFull, votersByUserId) {
  const voters = Array.isArray(auditFull?.voters) ? auditFull.voters : [];
  const totalVotingPower = {};
  const voterCount = {};
  for (const v of voters) {
    const answers = v?.evidence?.answers || [];
    const hasNonAbstain = answers.some(
      (a) => a?.abstain !== true && Array.isArray(a?.selection) && a.selection.length > 0
    );
    if (!hasNonAbstain) continue;
    const meta = votersByUserId.get(v.voterId);
    if (!meta) continue; // unmapped voter → excluded (authority ineligible or pre-vote placeholder)
    const group = meta.voterGroup || "default";
    voterCount[group] = (voterCount[group] || 0) + 1;
    totalVotingPower[group] =
      (totalVotingPower[group] || 0) + (meta.votingPower || 0);
  }
  return { totalVotingPower, voterCount };
}

/**
 * Per-proposal distinct-voter participation — same rule as
 * `ballotParticipationFromEvidence` but scoped to a single `questionId`.
 */
function proposalParticipationFromEvidence(auditFull, proposalId, votersByUserId) {
  const voters = Array.isArray(auditFull?.voters) ? auditFull.voters : [];
  const totalVotingPower = {};
  const voterCount = {};
  for (const v of voters) {
    const answer = (v?.evidence?.answers || []).find(
      (a) => a && a.questionId === proposalId
    );
    if (!answer) continue;
    const hasNonAbstain =
      answer.abstain !== true &&
      Array.isArray(answer.selection) &&
      answer.selection.length > 0;
    if (!hasNonAbstain) continue;
    const meta = votersByUserId.get(v.voterId);
    if (!meta) continue; // unmapped → excluded
    const group = meta.voterGroup || "default";
    voterCount[group] = (voterCount[group] || 0) + 1;
    totalVotingPower[group] =
      (totalVotingPower[group] || 0) + (meta.votingPower || 0);
  }
  return { totalVotingPower, voterCount };
}

/**
 * Main entry — derive the full per-proposal tally tuple for one proposal.
 *
 * @param {object} args
 * @param {object} args.ballot
 * @param {object} args.proposal
 * @param {object} args.auditFull — /audit/full response envelope's data
 * @param {Map<string, {voterGroup: string, votingPower: number}>} args.votersByUserId
 * @returns {{
 *   results: Array,
 *   resultsByGroup: object,
 *   ballotParticipation: {totalVotingPower: object, voterCount: object},
 *   proposalParticipation: {totalVotingPower: object, voterCount: object},
 * }}
 */
export function deriveProposalTally({ ballot, proposal, auditFull, votersByUserId }) {
  const proposalId = proposal._id.toString();
  const votes = votesForProposal(auditFull, proposalId);
  const results = deriveTopLevelResults(proposal, votes, votersByUserId);
  const resultsByGroup = deriveResultsByGroup({ ballot, proposal, votes, votersByUserId });
  const ballotParticipation = ballotParticipationFromEvidence(auditFull, votersByUserId);
  const proposalParticipation = proposalParticipationFromEvidence(
    auditFull,
    proposalId,
    votersByUserId
  );
  // Reconcile per-group totalVotes with the distinct-voter count —
  // matches the provisional cron's reconciliation at line 321-326.
  for (const group of Object.keys(resultsByGroup)) {
    const distinct = proposalParticipation.voterCount?.[group];
    if (typeof distinct === "number") {
      resultsByGroup[group].totalVotes = distinct;
    }
  }
  return { results, resultsByGroup, ballotParticipation, proposalParticipation };
}
