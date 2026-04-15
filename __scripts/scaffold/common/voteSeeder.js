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

function pickOption(proposal, r) {
  const opts = Array.isArray(proposal.voteOptions) ? proposal.voteOptions : [];
  if (opts.length === 0) return null;
  // Skew slightly toward "Yes" for default ballots so archived demos
  // have plausible outcomes rather than perfect 50/50 ties.
  if (proposal.voteType === "default" && opts.length >= 2) {
    if (proposal.abstainAllowed && r < 0.08) return ["abstain"];
    // 60% Yes, rest No — where option id 1 is canonical Yes in the factory.
    return [r < 0.68 ? opts[0].id : opts[1].id];
  }
  if (proposal.voteType === "scale") {
    // Uniform over declared scale options.
    return [opts[Math.floor(r * opts.length)].id];
  }
  if (proposal.voteType === "budget") {
    // Pick a single option; budget logic isn't modeled in scaffolds.
    return [opts[Math.floor(r * opts.length)].id];
  }
  return [opts[Math.floor(r * opts.length)].id];
}

/**
 * Decide whether a voter participates on this ballot+proposal for a
 * "live" demo. Deterministic per (ballot, user) so a voter is
 * consistent across proposals within a live ballot.
 */
function participates(ballotId, userId, turnout) {
  const r = prand(ballotId, userId, "__turnout");
  return r < turnout;
}

/**
 * Aggregate a set of votes into the Result shape the app expects.
 *
 * @returns {{ results: Array, totalVotes: number,
 *             resultsByGroup: Object }}
 */
function rollup(proposal, votes, votersByUserId) {
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
    const rows = proposal.voteOptions.map(optionRow);
    if (proposal.abstainAllowed) rows.push(abstainRow());
    return rows;
  };

  const byGroup = new Map(); // group → { results, totalVotes }
  const overall = makeTally();
  let totalOverall = 0;

  for (const v of votes) {
    const voter = votersByUserId.get(v.userId);
    if (!voter) continue;
    const power = voter.votingPower ?? 1;
    const group = voter.voterGroup || "default";

    if (!byGroup.has(group)) {
      byGroup.set(group, { results: makeTally(), totalVotes: 0 });
    }
    const g = byGroup.get(group);

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
  }

  const resultsByGroup = {};
  for (const [group, payload] of byGroup.entries()) {
    resultsByGroup[group] = payload;
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
 * @param {Object} proposal   Proposal document (needs _id, voteType, voteOptions, abstainAllowed)
 * @param {Array} voters     Voter objects from VOTERS fixture (needs userId, voterGroup, votingPower)
 * @param {"closed"|"live"|"upcoming"} state
 */
async function seedProposal(ballot, proposal, voters, state) {
  if (state === "upcoming") return { votes: 0, result: null };

  const turnout = state === "closed" ? 1.0 : 0.6;
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
  for (const voter of voters) {
    if (state === "live" && !participates(ballot._id.toString(), voter.userId, turnout)) {
      continue;
    }
    const r = prand(ballot._id.toString(), voter.userId, proposal._id.toString(), "pick");
    const vote = pickOption(proposal, r);
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
  const tally = rollup(proposal, cast, votersByUserId);

  const resultDoc = {
    proposalId: proposal._id,
    ballotId: ballot._id,
    ballotSource: ballot.source || "legacy",
    results: tally.results,
    resultsByGroup: tally.resultsByGroup,
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
