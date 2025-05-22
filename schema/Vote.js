import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Vote Schema
 * Represents a vote cast by a voter for a specific proposal within a ballot
 *
 * @typedef {Object} Vote
 * @property {String} voterId - ID of the voter who cast the vote (references Voter)
 * @property {ObjectId} ballotId - ID of the ballot the vote belongs to (references Ballot)
 * @property {ObjectId} proposalId - ID of the proposal being voted on (references Proposal)
 * @property {Number} value - Numeric value of the vote based on proposal's voteOptions
 * @property {Number} submittedValue - Last value that was submitted to Hydra (may differ from current value if changed)
 * @property {Date} submittedAt - Timestamp when the vote was last submitted to Hydra
 * @property {Date} createdAt - Timestamp when the vote was first created (immutable)
 * @property {Date} updatedAt - Timestamp when the vote was last updated
 *
 * @description
 * The Vote schema represents individual votes cast by voters on specific proposals.
 * Each vote links a voter to their choice on a particular proposal within a ballot.
 * Votes can exist in two states: pending (not yet submitted) and submitted.
 * When votes are submitted to Hydra, the submittedValue and submittedAt fields are updated.
 * If a voter changes their vote before submission, only the value field changes.
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
    value: {
      type: Number,
      required: true,
    },
    submittedValue: {
      type: Number,
      required: false,
    },
    submittedAt: {
      type: Date,
      required: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
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

// Pre-save middleware to update the updatedAt field
voteSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Vote = mongoose.model("Vote", voteSchema);
export { Vote };
