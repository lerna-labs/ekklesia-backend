import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Result Schema
 * Represents the voting results for a specific proposal
 *
 * @typedef {Object} Result
 * @property {ObjectId} proposalId - The ID of the proposal these results belong to (references Proposal)
 * @property {Object} results - Object containing the calculated voting results
 * @property {Date} createdAt - Timestamp when the results were first created (immutable)
 * @property {Date} updatedAt - Timestamp when the results were last updated
 *
 * @description
 * The Result schema stores the calculated outcome of voting for a specific proposal.
 * Each proposal has exactly one result record (enforced by the unique index on proposalId).
 * Results are calculated by the ballot's rollupScript and stored as a flexible object structure.
 * Timestamps are automatically managed to track creation and last update times.
 * The __v version key is removed from documents for cleaner output.
 */
const resultSchema = new Schema(
  {
    proposalId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Proposal",
      unique: true,
    },
    results: {
      type: Object,
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

// Pre-save middleware to update the updatedAt field
resultSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Result = mongoose.model("Result", resultSchema);
export { Result };
