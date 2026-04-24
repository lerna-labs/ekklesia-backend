// express router
import { Router } from "express";
const router = Router();

// schema import
import { Vote } from "../../../schema/Vote.js";
import { Ballot } from "../../../schema/Ballot.js";

// helper
import { isAuthenticated, getProposal } from "../../../helper/middleWare.js";
import { checkVotingWindow } from "../../../helper/votingWindow.js";

/**
 * @route POST /api/v0/vote/:proposalId
 * @description Submit or update a vote on a specific proposal. Creates a new vote or updates an existing one. Votes can be changed before submission via transaction. For budget vote type, validates that total cost doesn't exceed voterBudget. For scale vote type, validates that vote is within the allowed range with correct increment.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.proposalId - MongoDB ObjectId of the proposal to vote on
 * @param {Object} req.body
 * @param {Array<number|string>} req.body.vote - Array of vote option IDs (numbers) or "abstain" string. Must be one of the allowed values for the proposal. Duplicates are automatically removed. Abstain is allowed by default; proposals with `requireAnswer: true` reject it. When allowed, "abstain" must be the sole entry (cannot be combined with other votes).
 *
 * @returns {Object} 200 - The saved vote object containing:
 *   - _id: MongoDB ObjectId of the vote
 *   - userId: ID of the voter
 *   - ballotId: ID of the ballot
 *   - proposalId: ID of the proposal
 *   - vote: Array of current vote option IDs
 *   - submittedVote: Array of submitted vote option IDs (null if not yet submitted)
 *   - submittedAt: ISO 8601 timestamp when vote was submitted (null if not yet submitted)
 *   - changes: Boolean indicating if vote was changed (true if updatedAt > submittedAt or submittedAt is null)
 *   - createdAt: ISO 8601 timestamp when vote was created
 *   - updatedAt: ISO 8601 timestamp when vote was last updated
 * @returns {Object} 400 - Error if:
 *   - Vote data is missing, not an array, or empty
 *   - Ballot status is not "live"
 *   - Vote value(s) are not allowed for this proposal
 *   - Abstain is combined with other votes
 *   - Total cost exceeds voterBudget (for budget vote type)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 403 - Error if voter is not registered/validated for the ballot
 * @returns {Object} 404 - Error if proposal or ballot not found
 * @returns {Object} 500 - Error if vote cannot be saved to database
 */
router.post("/:proposalId", isAuthenticated, getProposal, async (req, res) => {
  const { proposal, userId, proposalId } = req;

  // Get ballot data
  const ballot = await Ballot.findOne({ _id: proposal.ballotId });
  if (!ballot) {
    return res.status(404).json({
      status: "error",
      message: "Ballot not found",
    });
  }
  // Check if the ballot is still open
  if (ballot.status !== "live") {
    return res.status(400).json({
      status: "error",
      message: "Ballot is not live",
    });
  }

  // Time-window gate independent of status. Status is flipped by the
  // 1min cron, which leaves up to a minute where votePeriodEnd has
  // elapsed but the ballot is still "live" in Mongo.
  const windowCheck = checkVotingWindow(ballot);
  if (!windowCheck.ok) {
    return res.status(409).json({
      status: "error",
      code: windowCheck.code,
      message: windowCheck.message,
    });
  }

  // validate the voter against the ballot
  const { loadValidationScript } = await import(
    "../../../helper/loadValidationScript.js"
  );
  const { validateVoter } = await loadValidationScript(
    ballot.voterValidationScript
  );
  // validate voter
  const isValidVoter = await validateVoter(userId, ballot._id);
  // return error if voter is not valid
  if (!isValidVoter) {
    return res.status(403).json({
      status: "error",
      message: "Voter is not registered for this ballot",
    });
  }

  // Validate the vote data
  const { vote } = req.body;
  // Check if vote is present and is an array
  if (!vote || !Array.isArray(vote) || vote.length === 0) {
    return res.status(400).json({
      status: "error",
      message: "Vote data is required",
    });
  }

  // Remove duplicate votes
  const uniqueVotes = [...new Set(vote)];

  // Abstain rules:
  //   - Proposals with requireAnswer: true reject any "abstain" entry.
  //   - Otherwise, "abstain" must be the only entry (cannot be combined
  //     with other votes).
  if (uniqueVotes.includes("abstain")) {
    if (proposal.requireAnswer === true) {
      return res.status(400).json({
        status: "error",
        message: "Invalid vote - this question requires an answer",
      });
    }
    if (uniqueVotes.length > 1) {
      return res.status(400).json({
        status: "error",
        message: "Invalid vote - Abstain does not allow other votes",
      });
    }
  }

  // Get allowed option IDs from proposal.voteOptions
  let allowedOptionIds = proposal.voteOptions.map((option) => option.id);

  // allowed values for scale votes
  if (proposal.voteType === "scale") {
    const lowerBound = proposal.voteOptions[0].id;
    const upperBound = proposal.voteOptions[proposal.voteOptions.length - 1].id;
    allowedOptionIds = Array.from({ length: (upperBound - lowerBound) / proposal.voteIncrement + 1 }, (_, i) => lowerBound + i * proposal.voteIncrement);
  }

  // Abstain is allowed by default unless the proposal sets requireAnswer: true.
  if (proposal.requireAnswer !== true) {
    allowedOptionIds.push("abstain");
  }

  // Check if all values in the vote array are present in the allowed option IDs
  const invalidVotes = uniqueVotes.filter(voteId => !allowedOptionIds.includes(voteId));
  if (invalidVotes.length > 0) {
    return res.status(400).json({
      status: "error",
      message: "Vote value is not allowed",
    });
  }

  // Calculate total cost by looking up the cost for each vote ID
  const totalCost = uniqueVotes.reduce((acc, voteId) => {
    const voteOption = proposal.voteOptions.find(option => option.id === voteId);
    return acc + (voteOption ? voteOption.cost : 0);
  }, 0);

  if (proposal.voterBudget && totalCost > proposal.voterBudget) {
    return res.status(400).json({
      status: "error",
      message: `Total cost (${totalCost}) exceeds your budget of ${proposal.voterBudget}`,
    });
  }

  // Build the vote data
  const voteData = {
    ballotId: proposal.ballotId,
    proposalId,
    userId,
    vote: uniqueVotes,
  };

  // save the vote to the database and return the saved vote
  const saveVote = await Vote.findOneAndUpdate(
    { proposalId: req.params.proposalId, userId: userId },
    voteData,
    { new: true, upsert: true }
  );
  // Check if the save operation was successful
  if (!saveVote) {
    return res.status(500).json({
      status: "error",
      message: "Failed to save vote",
    });
  }

  // check if saveVote.updatedAt is newer than saveVote.submittedAt or submittedAt does not exist yet
  const voteResponse = saveVote.toObject(); // Convert to plain object
  if (
    saveVote.updatedAt.getTime() >
    (saveVote?.submittedAt?.getTime() || !saveVote.submittedAt)
  ) {
    voteResponse.changes = true;
  }

  // return the response with changes field
  return res.status(200).json(voteResponse);
});

export default router;
