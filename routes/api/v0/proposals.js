// express router
import { Router } from "express";
const router = Router();

// schema import
import { Comment } from "../../../schema/Comment.js";
import { Vote } from "../../../schema/Vote.js";
import { Ballot } from "../../../schema/Ballot.js";
import { Result } from "../../../schema/Result.js";

// helper
import { cacheControl } from "../../../helper/cacheControl.js";
import { getProposal } from "../../../helper/middleWare.js";
import { verifyToken } from "../../../helper/verifyToken.js";

/**
 * @route GET /api/v0/proposals/:proposalId
 * @description Get a proposal by ID with voting statistics and user vote if authenticated. Response is cached for 300 seconds.
 * @access Public (enhanced with user-specific data if authenticated)
 *
 * @param {string} req.params.proposalId - MongoDB ObjectId of the proposal to retrieve
 *
 * @returns {Object} 200 - The proposal object with additional fields:
 *   - All standard proposal fields (title, description, voteType, voteOptions, etc.)
 *   - voterVote: Array of vote option IDs the authenticated voter selected, or null if not voted or not authenticated
 *   - ballotStatus: Status of the parent ballot ("live", "closed", or "upcoming")
 *   - results: Calculated voting results object (null if not yet calculated)
 *   - totalVotes: Total number of submitted votes on this proposal
 *   - totalVoterCount: Total number of voters eligible to vote in the parent ballot
 *   - totalVotingPower: Total voting power across all eligible voters in the parent ballot
 * @returns {Object} 400 - Error if proposal ID format is invalid (handled by getProposal middleware)
 * @returns {Object} 404 - Error if proposal not found (handled by getProposal middleware)
 * @returns {Object} 500 - Server error (handled by getProposal middleware)
 */
router.get("/:proposalId", cacheControl(300), getProposal, async (req, res) => {
  const { proposalId, proposal } = req;
  const voterToken = verifyToken(req);
  const voterId = voterToken.voterId || false;

  // fetch total vote count
  const totalVotes = await Vote.countDocuments({
    proposalId,
    submittedValue: { $exists: true, $ne: null },
  });

  // fetch user vote
  if (voterId) {
    const userVote = await Vote.findOne({
      proposalId,
      voterId,
    }).lean();

    // add user vote to proposal object
    proposal.voterVote = userVote?.value ?? null;
  }

  // fetch results
  // !! needs to be removed if preliminary voting is false
  const results = await Result.findOne({
    proposalId,
  }).lean();

  // fetch ballot details
  const ballot = await Ballot.findOne({ _id: proposal.ballotId });

  // get total voter count
  const { allowedVoterCount, getTotalWeight } = await import(
    "../../../config/" + ballot.voterValidationScript
  );
  const totalVoterCount = await allowedVoterCount(ballot._id);
  const totalVotingPower = await getTotalWeight(ballot._id);

  // add additional fields to proposal object
  proposal.ballotStatus = ballot.status;
  proposal.results = results?.results;
  proposal.totalVotes = totalVotes;
  proposal.totalVoterCount = totalVoterCount;
  proposal.totalVotingPower = totalVotingPower;

  return res.status(200).json(proposal);
});

/**
 * @route GET /api/v0/proposals/:proposalId/comments
 * @description Get all comments for a specific proposal sorted by creation date (newest first). Returns empty array if no comments exist.
 * @access Public
 *
 * @param {string} req.params.proposalId - MongoDB ObjectId of the proposal to get comments for
 *
 * @returns {Array} 200 - Array of comment objects sorted by createdAt (descending), each containing:
 *   - _id: MongoDB ObjectId of the comment
 *   - proposalId: ID of the proposal
 *   - voterId: ID of the voter who created the comment
 *   - content: Comment content (sanitized)
 *   - createdAt: ISO 8601 timestamp when comment was created
 *   - updatedAt: ISO 8601 timestamp when comment was last updated
 * @returns {Object} 400 - Error if proposal ID format is invalid (handled by getProposal middleware)
 * @returns {Object} 404 - Error if proposal not found (handled by getProposal middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:proposalId/comments", getProposal, async (req, res) => {
  const { proposalId } = req;
  // Fetch the comments from the database
  const comments = await Comment.find({
    proposalId,
  }).sort({ createdAt: -1 });

  // Return 404 if no comments are found
  if (!comments) {
    return res.status(404).json({
      status: "error",
      message: "No comments found",
    });
  }

  return res.status(200).json(comments);
});

/**
 * @route GET /api/v0/proposals/:proposalId/results
 * @description Get voting results for a specific proposal with vote counts and voting power. Results are calculated from submitted votes only.
 * @access Public
 *
 * @param {string} req.params.proposalId - MongoDB ObjectId of the proposal to get results for
 *
 * @returns {Object} 200 - The proposal object with voting results added:
 *   - All standard proposal fields
 *   - results: Array of result objects, each containing:
 *     - value: Vote option ID (number) or "abstain" string
 *     - label: Display label for the vote option
 *     - count: Number of votes cast for this option
 *     - votingPower: Total voting power of votes cast for this option
 *   - totalVotes: Total number of submitted votes across all options
 * @returns {Object} 400 - Error if proposal ID format is invalid (handled by getProposal middleware)
 * @returns {Object} 404 - Error if proposal not found (handled by getProposal middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:proposalId/results", getProposal, async (req, res) => {
  let { proposalId, proposal } = req;

  // Get the ballot ID from the proposal
  const ballotId = proposal.ballotId;

  // vote aggregation
  const voteAggregation = await Vote.aggregate([
    { $match: { proposalId } },
    {
      $lookup: {
        from: "votercaches", // collection name in MongoDB
        let: { voterId: "$voterId", ballotId: ballotId },
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
        voterData: 1,
      },
    },
  ]);

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

  // response object
  const response = proposal;

  // add additional fields to proposal object
  response.results = resultsWithLabels;
  response.totalVotes = voteAggregation.reduce(
    (acc, result) => acc + result.count,
    0
  );

  return res.status(200).json(response); // Return the processed response instead of raw aggregation
});

/**
 * @route GET /api/v0/proposals/:proposalId/short
 * @description Get a shortened version of a proposal without the detailed data field. Useful for lightweight proposal listings.
 * @access Public
 *
 * @param {string} req.params.proposalId - MongoDB ObjectId of the proposal to retrieve
 *
 * @returns {Object} 200 - The proposal object with all fields except the data field removed
 * @returns {Object} 400 - Error if proposal ID format is invalid (handled by getProposal middleware)
 * @returns {Object} 404 - Error if proposal not found (handled by getProposal middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:proposalId/short", getProposal, async (req, res) => {
  let { proposalId, proposal } = req;

  delete proposal.data;

  return res.status(200).json(proposal); // Return the processed response instead of raw aggregation
});

export default router;
