// express router
import { Router } from "express";
const router = Router();

// schema import
import { Vote } from "../../../schema/Vote.js";
import { Ballot } from "../../../schema/Ballot.js";

// helper
import { isAuthenticated, getProposal } from "../../../helper/middleWare.js";

/**
 * @route POST /api/v0/vote/:proposalId
 * @description Submit or update a vote on a specific proposal
 * @access Private (requires authentication)
 *
 * @param {string} req.params.proposalId - ID of the proposal to vote on
 * @param {Object} req.body
 * @param {number} req.body.vote - The vote value (must be one of the allowed values for the proposal)
 *
 * @returns {Object} 200 - The saved vote object with indication if vote was changed
 * @returns {Object} 400 - Error if ballot is not live, vote value is missing or not allowed
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 403 - Error if voter not registered for ballot
 * @returns {Object} 404 - Error if proposal or ballot not found
 * @returns {Object} 500 - Error if vote cannot be saved
 */
router.post("/:proposalId", isAuthenticated, getProposal, async (req, res) => {
  const { proposal, voterId, proposalId } = req;

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

  // validate the voter against the ballot
  const { validateVoter } = await import(
    "../../../config/" + ballot.voterValidationScript
  );
  // validate voter
  const isValidVoter = await validateVoter(voterId, ballot._id);
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

  // Get allowed option IDs from proposal.voteOptions
  let allowedOptionIds = proposal.voteOptions.map((option) => option.id);

  // !! different logic for scale votes here

  // Add abstain if proposal.abstainAllowed = true
  if (proposal.abstainAllowed) {
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
    voterId,
    vote: uniqueVotes,
  };

  // save the vote to the database and return the saved vote
  const saveVote = await Vote.findOneAndUpdate(
    { proposalId: req.params.proposalId, voterId: voterId },
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
