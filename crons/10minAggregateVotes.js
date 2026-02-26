import { Vote } from "../schema/Vote.js";
import { VoterCache } from "../schema/VoterCache.js";
import { Proposal } from "../schema/Proposal.js";
import { Result } from "../schema/Result.js";

export async function aggregateVotes() {
  const now = new Date();
  // Use 12 minutes to ensure overlap and catch all votes
  const twelveMinutesAgo = new Date(now.getTime() - 12 * 60 * 1000);

  // Get all proposalIds that have votes submitted in the last 12 minutes
  const proposalIds = await Vote.find({
    submittedAt: { $gte: twelveMinutesAgo, $lt: now },
  }).distinct("proposalId");

  if (proposalIds.length === 0) {
    console.log("No proposals to process");
    return;
  }

  for (const proposalId of proposalIds) {
    console.log("Processing proposal:", proposalId.toString());

    // get the proposal from the database with complete data
    const proposal = await Proposal.findById(proposalId);
    if (!proposal) {
      console.error(`Proposal not found: ${proposalId}`);
      continue;
    }

    // Check if there are actually new votes in the last 12 minutes for this proposal
    const recentVotesCount = await Vote.countDocuments({
      proposalId: proposalId,
      submittedAt: { $gte: twelveMinutesAgo, $lt: now },
    });

    if (recentVotesCount === 0) {
      console.log(`Skipping proposal ${proposalId}: no recent votes`);
      continue;
    }

    const voteAggregation = await Vote.aggregate([
      // Add time filter to only aggregate ALL votes for proposals with recent activity
      { $match: { proposalId } },
      {
        $lookup: {
          from: "votercaches", // collection name in MongoDB
          let: { voterId: "$voterId", ballotId: proposal.ballotId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$voterId", "$$voterId"] },
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
          // Extract the votingPower directly from the first element of voterData array
          votingPower: {
            $ifNull: [{ $arrayElemAt: ["$voterData.votingPower", 0] }, 1],
          },
        },
      },
      // Unwind the submittedVote array to handle multiple vote options
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
      {
        $project: {
          _id: 1,
          count: 1,
          votingPower: 1,
        },
      },
    ]);

    // Add console logging to help debug
    console.log(
      "Vote aggregation results:",
      JSON.stringify(voteAggregation, null, 2)
    );

    // restructure results with labels
    const resultsWithLabels = proposal.voteOptions.map((option) => {
      // Find if there's a matching result from the aggregation
      const matchingResult = voteAggregation.find(
        (result) => result._id == option.id
      );

      return {
        id: option.id,
        label: option.label,
        count: matchingResult ? matchingResult.count : 0,
        votingPower: matchingResult ? matchingResult.votingPower : 0,
      };
    });

    // add abstain votes if allowed on proposal
    if (proposal.abstainAllowed) {
      const matchingAbstainResult = voteAggregation.find(
        (result) => result._id == "abstain"
      );

      resultsWithLabels.push({
        id: "abstain",
        label: "Abstain",
        count: matchingAbstainResult ? matchingAbstainResult.count : 0,
        votingPower: matchingAbstainResult ? matchingAbstainResult.votingPower : 0,
      });
    }

    // By-group aggregation: same pipeline + voterGroup, group by voterGroup and vote value
    const byGroupAggregation = await Vote.aggregate([
      { $match: { proposalId, submittedVote: { $exists: true, $ne: null } } },
      {
        $lookup: {
          from: "votercaches",
          let: { voterId: "$voterId", ballotId: proposal.ballotId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$voterId", "$$voterId"] },
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

    // Build resultsByGroup: { "<voterGroup>": { results: [{ id, label, count, votingPower }], totalVotes } }
    const resultsByGroup = {};
    for (const row of byGroupAggregation) {
      const groupKey = row._id.voterGroup;
      if (!resultsByGroup[groupKey]) {
        resultsByGroup[groupKey] = { results: [], totalVotes: 0 };
      }
      const option = proposal.voteOptions.find((o) => o.id == row._id.voteValue);
      const label = option ? option.label : (row._id.voteValue === "abstain" ? "Abstain" : String(row._id.voteValue));
      resultsByGroup[groupKey].results.push({
        id: row._id.voteValue,
        label,
        count: row.count,
        votingPower: row.votingPower,
      });
      resultsByGroup[groupKey].totalVotes += row.count;
    }
    if (proposal.abstainAllowed) {
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

    // upsert the result into the database (results + resultsByGroup)
    await Result.updateOne(
      { proposalId },
      { results: resultsWithLabels, resultsByGroup },
      { upsert: true }
    );

    console.log(`Results for proposal ${proposalId} updated successfully`);
  }

  console.log(`Finished processing ${proposalIds.length} proposals`);
}
