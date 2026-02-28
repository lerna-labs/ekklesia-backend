import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Vote Schema
 * Represents a vote cast by a voter for a specific proposal within a ballot
 *
 * @typedef {Object} Vote
 * @property {String} voterId - ID of the voter who cast the vote (references Voter, format depends on voterType)
 * @property {ObjectId} ballotId - ID of the ballot the vote belongs to (references Ballot)
 * @property {ObjectId} proposalId - ID of the proposal being voted on (references Proposal)
 * @property {Array<Number|String>} vote - Current value of the vote (may differ from submittedVote if changed)
 *                                        Array of vote option IDs (numbers) or "abstain" string.
 *                                        For scale votes, contains the numeric value.
 *                                        For budget votes, contains multiple option IDs that fit within voter's budget.
 * @property {Array<Number|String>} submittedVote - Value of the vote when it was last submitted via transaction
 *                                                  Array of vote option IDs that were submitted (numbers) or "abstain" string.
 *                                                  Null if the vote has never been submitted.
 * @property {Date} submittedAt - Timestamp when the vote was last submitted via transaction (null if never submitted)
 * @property {Date} createdAt - Timestamp when the vote was first created (immutable)
 * @property {Date} updatedAt - Timestamp when the vote was last updated (changes when vote value is modified)
 *
 * @description
 * The Vote schema represents individual votes cast by voters on specific proposals.
 * Each vote links a voter to their choice on a particular proposal within a ballot.
 * Votes can exist in two states: pending (not yet submitted) and submitted.
 * When votes are submitted via transaction, the submittedVote and submittedAt fields are updated.
 * If a voter changes their vote before submission, only the vote field changes.
 * Each voter can only have one vote per proposal (enforced by unique index on proposalId + voterId).
 * Composite indexes are maintained for efficient querying by voterId, proposalId, and ballotId.
 * Timestamps are automatically managed to track creation and modification times.
 * The __v version key is removed from documents for cleaner output.
 */
const voteSchema = new Schema(
  {
    voterId: {
      type: String,
      required: true,
      ref: "Voter",
    },
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Ballot",
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Proposal",
    },
    vote: {
      type: Array,
      required: true,
    },
    submittedVote: {
      type: Array,
      required: false,
    },
    submittedAt: {
      type: Date,
      required: false,
    }
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
  }
);

// Indexes for faster queries
voteSchema.index({ voterId: 1 });
voteSchema.index({ proposalId: 1 });
voteSchema.index({ ballotId: 1 });
voteSchema.index({ proposalId: 1, voterId: 1 }, { unique: true });

const Vote = mongoose.model("Vote", voteSchema);
export { Vote };
