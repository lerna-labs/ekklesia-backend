// express router
import { Router } from "express";
const router = Router();

// schema import
import { Proposal } from "../../../schema/Proposal.js";
import { Comment } from "../../../schema/Comment.js";
import { Ballot } from "../../../schema/Ballot.js";

// helper
import validator from "validator";
import { sanitizeInput } from "../../../helper/sanitizeInput.js";

// middleware
import { isAuthenticated } from "../../../helper/middleWare.js";

/**
 * @route POST /api/v0/comment
 * @description Creates a new comment on a specific proposal
 * @access Private (requires authentication)
 *
 * @param {Object} req.body
 * @param {string} req.body.proposalId - ID of the proposal to comment on
 * @param {string} req.body.comment - Comment content (max 1000 characters)
 *
 * @returns {Object} 200 - The saved comment object
 * @returns {Object} 400 - Error if missing required fields, invalid format, or comment too long
 * @returns {Object} 403 - Error if voter not registered for the ballot
 * @returns {Object} 404 - Error if proposal or ballot not found
 * @returns {Object} 500 - Error if comment cannot be saved
 */
router.post("/", isAuthenticated, async (req, res) => {
  const voterId = req.voterId;

  // Validate the request body
  const { proposalId, comment } = req.body;
  if (!proposalId || !comment) {
    return res.status(400).json({
      status: "error",
      message: "Proposal ID and comment are required",
    });
  }

  // validate proposalId
  if (!validator.isAlphanumeric(proposalId)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid proposal ID format",
    });
  }

  // Check if the proposal exists
  const proposal = await Proposal.findOne({ _id: proposalId });
  if (!proposal) {
    return res.status(404).json({
      status: "error",
      message: "Proposal not found",
    });
  }

  // Check if the proposal is open for comments
  const ballot = await Ballot.findOne({ _id: proposal.ballotId });
  if (!ballot) {
    return res.status(404).json({
      status: "error",
      message: "Ballot not found",
    });
  }
  if (ballot.status !== "live" && ballot.status !== "upcoming") {
    return res.status(400).json({
      status: "error",
      message: "Proposal is not open for comments",
    });
  }

  // validate voter
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

  // Validate the comment data
  if (!comment) {
    return res.status(400).json({
      status: "error",
      message: "Comment data is required",
    });
  }

  // Check if the comment is too long
  if (comment.length > 1000) {
    return res.status(400).json({
      status: "error",
      message: "Comment is too long",
    });
  }

  // Sanitize the comment
  const sanitizedComment = sanitizeInput(comment);
  if (!sanitizedComment) {
    return res.status(400).json({
      status: "error",
      message: "Invalid comment format",
    });
  }

  // Create a new comment
  const newComment = new Comment({
    proposalId,
    voterId,
    content: sanitizedComment,
  });

  // Save the comment to the database
  const savedComment = await newComment.save();

  // Check if the comment was saved successfully
  if (!savedComment) {
    return res.status(500).json({
      status: "error",
      message: "Failed to save comment",
    });
  }

  return res.status(200).json(savedComment);
});

export default router;
