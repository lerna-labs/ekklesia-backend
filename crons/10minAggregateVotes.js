import { Vote } from "../schema/Vote.js";
import { UserCache } from "../schema/UserCache.js";
import { Proposal } from "../schema/Proposal.js";
import { Ballot } from "../schema/Ballot.js";
import { Result } from "../schema/Result.js";
import {
  computeBallotParticipation,
  computeProposalParticipation,
} from "../helper/results/ballotParticipation.js";
import {
  computeScaleStats,
  bucketScaleSamplesByGroup,
} from "../helper/results/scaleStats.js";
import { computeRankedDistribution } from "../helper/results/rankedDistribution.js";
import { computeLikertStats, bucketLikertVotesByGroup } from "../helper/results/likertStats.js";
import { computeWeightedStats, bucketWeightedVotesByGroup } from "../helper/results/weightedStats.js";
import { forBallot, HydraClientError } from "../helper/hydraClient.js";
import { buildVotersByUserId } from "../helper/hydraEvidence.js";
import { deriveProposalTally } from "../helper/results/hydraTally.js";

// Runs every ~10 minutes (see crons/10min.js wiring). Produces provisional
// tallies for every proposal that has recent activity.
//
// Source-aware behavior:
//   - Legacy ballots: always tallied, stamped source: "provisional"
//     (consistent with historical behavior — a final result is written when
//     someone calls the archival rollup flow, out of scope for this cron).
//   - Hydra ballots WITH provisionalResultsEnabled: tallied the same way;
//     the Vote rows are populated by the broker's mirror (syncVoteRecords).
//   - Hydra ballots WITHOUT provisionalResultsEnabled: skipped. A final
//     result lands via writeFinalResult() when Hydra /finalize returns.
//
// An existing Result with source: "final" is never overwritten by this cron.

export async function aggregateVotes() {
  const now = new Date();
  // Use 12 minutes to ensure overlap and catch all votes
  const twelveMinutesAgo = new Date(now.getTime() - 12 * 60 * 1000);

  const proposalIds = await Vote.find({
    submittedAt: { $gte: twelveMinutesAgo, $lt: now },
  }).distinct("proposalId");

  if (proposalIds.length === 0) {
    console.log("No proposals to process");
    return;
  }

  const ballotCache = new Map();
  async function loadBallot(id) {
    const key = id.toString();
    if (!ballotCache.has(key)) {
      ballotCache.set(key, await Ballot.findById(id).lean());
    }
    return ballotCache.get(key);
  }

  for (const proposalId of proposalIds) {
    console.log("Processing proposal:", proposalId.toString());

    const proposal = await Proposal.findById(proposalId);
    if (!proposal) {
      console.error(`Proposal not found: ${proposalId}`);
      continue;
    }

    const ballot = await loadBallot(proposal.ballotId);
    if (!ballot) {
      console.warn(`Ballot missing for proposal ${proposalId} — skipping`);
      continue;
    }

    if (ballot.source === "hydra" && !ballot.provisionalResultsEnabled) {
      console.log(
        `Skipping Hydra proposal ${proposalId}: provisional results disabled`
      );
      continue;
    }

    const existing = await Result.findOne({ proposalId }).lean();
    if (existing?.source === "final") {
      console.log(`Skipping proposal ${proposalId}: already finalized`);
      continue;
    }

    const recentVotesCount = await Vote.countDocuments({
      proposalId,
      submittedAt: { $gte: twelveMinutesAgo, $lt: now },
    });
    if (recentVotesCount === 0) {
      console.log(`Skipping proposal ${proposalId}: no recent votes`);
      continue;
    }

    const voteAggregation = await Vote.aggregate([
      { $match: { proposalId } },
      {
        $lookup: {
          from: "usercaches",
          let: { userId: "$userId", ballotId: proposal.ballotId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$userId"] },
                    { $eq: ["$ballotId", "$$ballotId"] },
                  ],
                },
              },
            },
          ],
          as: "voterData",
        },
      },
      {
        $addFields: {
          votingPower: {
            $ifNull: [{ $arrayElemAt: ["$voterData.votingPower", 0] }, 1],
          },
        },
      },
      {
        $unwind: {
          path: "$submittedVote",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: "$submittedVote",
          count: { $sum: 1 },
          votingPower: { $sum: "$votingPower" },
        },
      },
      { $project: { _id: 1, count: 1, votingPower: 1 } },
    ]);

    const resultsWithLabels = proposal.voteOptions.map((option) => {
      const match = voteAggregation.find((r) => r._id == option.id);
      return {
        id: option.id,
        label: option.label,
        count: match ? match.count : 0,
        votingPower: match ? match.votingPower : 0,
      };
    });

    if (proposal.requireAnswer !== true) {
      const abstain = voteAggregation.find((r) => String(r._id) === "abstain");
      resultsWithLabels.push({
        id: "abstain",
        label: "Abstain",
        count: abstain ? abstain.count : 0,
        votingPower: abstain ? abstain.votingPower : 0,
      });
    }

    const byGroupAggregation = await Vote.aggregate([
      { $match: { proposalId, submittedVote: { $exists: true, $ne: null } } },
      {
        $lookup: {
          from: "usercaches",
          let: { userId: "$userId", ballotId: proposal.ballotId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$userId"] },
                    { $eq: ["$ballotId", "$$ballotId"] },
                  ],
                },
              },
            },
          ],
          as: "voterData",
        },
      },
      {
        $addFields: {
          votingPower: {
            $ifNull: [{ $arrayElemAt: ["$voterData.votingPower", 0] }, 1],
          },
          voterGroup: {
            $ifNull: [{ $arrayElemAt: ["$voterData.voterGroup", 0] }, "default"],
          },
        },
      },
      { $unwind: { path: "$submittedVote", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: { voterGroup: "$voterGroup", voteValue: "$submittedVote" },
          count: { $sum: 1 },
          votingPower: { $sum: "$votingPower" },
        },
      },
    ]);

    const resultsByGroup = {};
    for (const row of byGroupAggregation) {
      const groupKey = row._id.voterGroup;
      if (!resultsByGroup[groupKey]) {
        resultsByGroup[groupKey] = { results: [], totalVotes: 0 };
      }
      const option = proposal.voteOptions.find((o) => o.id == row._id.voteValue);
      const label = option
        ? option.label
        : row._id.voteValue === "abstain"
        ? "Abstain"
        : String(row._id.voteValue);
      resultsByGroup[groupKey].results.push({
        id: row._id.voteValue,
        label,
        count: row.count,
        votingPower: row.votingPower,
      });
      resultsByGroup[groupKey].totalVotes += row.count;
    }
    if (proposal.requireAnswer !== true) {
      for (const groupKey of Object.keys(resultsByGroup)) {
        const hasAbstain = resultsByGroup[groupKey].results.some((r) => r.id === "abstain");
        if (!hasAbstain) {
          const abstainRow = byGroupAggregation.find(
            (r) => r._id.voterGroup === groupKey && r._id.voteValue === "abstain"
          );
          resultsByGroup[groupKey].results.push({
            id: "abstain",
            label: "Abstain",
            count: abstainRow ? abstainRow.count : 0,
            votingPower: abstainRow ? abstainRow.votingPower : 0,
          });
          if (abstainRow) resultsByGroup[groupKey].totalVotes += abstainRow.count;
        }
      }
    }

    // Augment per-group results with scale/ranked sub-objects and
    // ballot-level participation. Pulls the raw Vote rows once and
    // joins against UserCache for voterGroup + votingPower; the
    // existing aggregations above don't expose enough structure for
    // the helpers (which want per-voter rows, not pre-grouped tallies).
    if (
      proposal.voteType === "scale" ||
      proposal.voteType === "ranked" ||
      proposal.voteType === "likert" ||
      proposal.voteType === "weighted"
    ) {
      const rawVotes = await Vote.find({
        proposalId,
        submittedAt: { $ne: null },
      })
        .select("userId vote submittedVote")
        .lean();
      const voterIds = rawVotes.map((v) => v.userId);
      const voterRows = await UserCache.find({
        ballotId: ballot._id,
        userId: { $in: voterIds },
      })
        .select("userId voterGroup votingPower")
        .lean();
      const votersByUserId = new Map(voterRows.map((v) => [v.userId, v]));
      const votesForHelpers = rawVotes.map((v) => ({
        userId: v.userId,
        vote: Array.isArray(v.submittedVote) ? v.submittedVote : v.vote,
      }));

      if (proposal.voteType === "scale") {
        const samplesByGroup = bucketScaleSamplesByGroup(votesForHelpers, votersByUserId);
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
          votes: votesForHelpers,
          votersByUserId,
        });
        for (const [group, dist] of distByGroup.entries()) {
          if (!resultsByGroup[group]) continue;
          resultsByGroup[group].ranked = dist;
        }
      } else if (proposal.voteType === "likert") {
        const votesByGroup = bucketLikertVotesByGroup(votesForHelpers, votersByUserId);
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
        const votesByGroup = bucketWeightedVotesByGroup(votesForHelpers, votersByUserId);
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

    const [ballotParticipation, proposalParticipation] = await Promise.all([
      computeBallotParticipation(ballot._id),
      computeProposalParticipation(proposalId, ballot._id),
    ]);

    // Reconcile per-group totalVotes with distinct voter counts. The
    // $unwind + $sum:1 aggregation above counts vote *targets*, which
    // over-counts ranked (N rank slots per voter) and budget (M
    // selections per voter). proposalParticipation.voterCount is the
    // canonical distinct-voter count, so use that everywhere
    // totalVotes appears for consistency with the field's name.
    for (const groupKey of Object.keys(resultsByGroup)) {
      const distinct = proposalParticipation.voterCount?.[groupKey];
      if (typeof distinct === "number") {
        resultsByGroup[groupKey].totalVotes = distinct;
      }
    }

    await Result.updateOne(
      { proposalId },
      {
        $set: {
          results: resultsWithLabels,
          resultsByGroup,
          ballotParticipation,
          proposalParticipation,
          source: "provisional",
          ballotSource: ballot.source,
          ballotId: ballot._id,
        },
      },
      { upsert: true }
    );

    console.log(
      `[provisional] results for proposal ${proposalId} (${ballot.source}) updated`
    );
  }

  console.log(`Finished processing ${proposalIds.length} proposals`);
}

/**
 * Write final results for every proposal under a ballot. Called from the
 * admin /finalize handler after Hydra /finalize returns. Stamps source:
 * "final" and finalizedAt; unconditionally overwrites any provisional
 * tally.
 *
 * @param {string|ObjectId} ballotId
 * @param {Object} [hydraData]  — whatever Hydra /finalize returned
 */
export async function writeFinalResult(ballotId, hydraData = {}) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) throw new Error(`Ballot ${ballotId} not found`);

  const proposals = await Proposal.find({ ballotId }).lean();

  // Fetch /audit/full so we can derive per-proposal tallies from per-voter
  // evidence — matching the provisional-cron shape 1:1. Tolerant of
  // failure: if Hydra is unreachable or returns malformed data we still
  // stamp the provenance fields onto every Result doc so the caller can
  // replay via POST /api/v1/admin/ballots/:id/results/recover.
  let auditFull = null;
  try {
    const client = await forBallot(ballotId);
    auditFull = await client.auditFull();
  } catch (err) {
    const tag = err instanceof HydraClientError ? `${err.status || ""} ${err.code || ""}`.trim() : err.message;
    console.warn(`[final] /audit/full fetch failed (${tag}) — provenance will be stamped, tallies deferred to /results/recover`);
  }

  const votersByUserId = auditFull
    ? await buildVotersByUserId(auditFull, ballotId, UserCache)
    : new Map();

  const finalizedAt = new Date();
  for (const proposal of proposals) {
    // Derive from evidence when available; otherwise fall back to whatever
    // the provisional cron last wrote so we don't regress a good tally.
    let derived = null;
    if (auditFull) {
      try {
        derived = deriveProposalTally({
          ballot,
          proposal,
          auditFull,
          votersByUserId,
        });
      } catch (err) {
        console.warn(
          `[final] deriveProposalTally failed for proposal ${proposal._id}: ${err.message}`
        );
      }
    }
    const provisional = derived ? null : await Result.findOne({ proposalId: proposal._id }).lean();

    await Result.updateOne(
      { proposalId: proposal._id },
      {
        $set: {
          results: derived?.results || provisional?.results || [],
          resultsByGroup:
            derived?.resultsByGroup || provisional?.resultsByGroup || null,
          ballotParticipation:
            derived?.ballotParticipation || provisional?.ballotParticipation || null,
          proposalParticipation:
            derived?.proposalParticipation ||
            provisional?.proposalParticipation ||
            null,
          source: "final",
          ballotSource: ballot.source,
          ballotId: ballot._id,
          finalizedAt,
          // Hydra /settle/finalize (and /finalize) return:
          //   { txHash, resultsHash, evidenceDirectoryCid, resultsCid,
          //     evidenceMerkleRoot, totalVoters, excludedVoters, tallies }
          // We persist the provenance subset for auditability — resultsHash
          // and evidenceMerkleRoot are anchored on the (601) datum so
          // auditors can independently verify the pinned artifacts match
          // on-chain. `tallies` is intentionally NOT consumed here: the
          // per-ballot helpers reached via `deriveProposalTally` above
          // are the single source of derivation truth, feeding on the same
          // per-voter evidence Hydra used internally.
          hydraEvidenceCid:
            hydraData?.evidenceDirectoryCid ||
            hydraData?.resultsCid ||
            hydraData?.evidenceCid ||
            null,
          hydraFinalizeTxHash: hydraData?.txHash || null,
          hydraResultsHash: hydraData?.resultsHash || null,
          hydraEvidenceMerkleRoot: hydraData?.evidenceMerkleRoot || null,
          hydraResultsCid: hydraData?.resultsCid || null,
          hydraTotalVoters:
            typeof hydraData?.totalVoters === "number" ? hydraData.totalVoters : null,
          hydraExcludedVoters: Array.isArray(hydraData?.excludedVoters)
            ? hydraData.excludedVoters
            : [],
        },
      },
      { upsert: true }
    );
    console.log(`[final] results for proposal ${proposal._id} stamped`);
  }
}
