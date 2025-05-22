import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Comment Schema
 * Represents a comment made by a voter on a proposal
 *
 * @typedef {Object} Comment
 * @property {ObjectId} proposalId - The ID of the proposal this comment belongs to (references Proposal)
 * @property {String} voterId - The ID of the voter who made the comment (references Voter)
 * @property {String} content - The content of the comment (required)
 * @property {Date} createdAt - Timestamp when the comment was created (immutable)
 * @property {Date} updatedAt - Timestamp when the comment was last updated
 *
 * @description
 * Comments allow voters to provide feedback or ask questions about proposals.
 * The schema includes references to both the proposal and the voter who created the comment.
 * Timestamps are automatically managed to track creation and modification times.
 * An index on proposalId is maintained for efficient retrieval of all comments for a proposal.
 */
const commentSchema = new Schema(
  {
    proposalId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Proposal",
    },
    voterId: {
      type: String,
      required: true,
      ref: "Voter",
    },
    content: {
      type: String,
      required: true,
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
commentSchema.index({ proposalId: 1 });

// Pre-save middleware to update the updatedAt field
commentSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Comment = mongoose.model("Comment", commentSchema);
export { Comment };
