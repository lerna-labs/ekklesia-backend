import { Vote } from "../schema/Vote.js";
import { VoterCache } from "../schema/VoterCache.js";
import { Proposal } from "../schema/Proposal.js";
import { Result } from "../schema/Result.js";

export async function aggregateVotes() {
  const now = new Date();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

  // Get all votes that were submittedAt in the last 11 minutes
  // const proposalIds = await Vote.find({
  //   submittedAt: { $gte: fifteenMinutesAgo, $lt: now },
  // }).distinct("proposalId");

  const proposalIds = await Vote.find({}).distinct("proposalId");

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

    // Check if we've already processed this proposal in the last 10 minutes
    const lastResult = await Result.findOne({
      proposalId: proposalId,
    }).sort({ updatedAt: -1 });

    if (lastResult && lastResult.updatedAt > tenMinutesAgo) {
      console.log(
        `Skipping proposal ${proposalId}: already processed at ${lastResult.updatedAt}`
      );
      continue;
    }

    const voteAggregation = await Vote.aggregate([
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
      {
        $group: {
          _id: "$submittedValue",
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

    const resultsWithLabels = proposal.voteOptions.map((option) => {
      // Find if there's a matching result from the aggregation
      const matchingResult = voteAggregation.find(
        (result) => result._id == option.value
      );

      return {
        value: option.value,
        label: option.label,
        count: matchingResult ? matchingResult.count : 0,
        votingPower: matchingResult ? matchingResult.votingPower : 0,
      };
    });

    // upsert the result into the database
    await Result.updateOne(
      { proposalId },
      { results: resultsWithLabels },
      { upsert: true }
    );

    console.log(`Results for proposal ${proposalId} updated successfully`);
  }

  console.log(`Finished processing ${proposalIds.length} proposals`);
}
