import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * VoterCache Schema
 * Stores validation status and voting power for voters across different ballots
 *
 * @typedef {Object} VoterCache
 * @property {ObjectId} ballotId - The ID of the ballot this validation belongs to (references Ballot)
 * @property {String} voterId - The ID of the voter who is validated (references Voter)
 * @property {Boolean} validated - Whether the voter has been validated for this ballot
 * @property {Number} votingPower - The calculated voting power of the voter for this ballot
 * @property {Date} createdAt - Timestamp when the validation record was created (immutable)
 * @property {Date} updatedAt - Timestamp when the validation record was last updated
 *
 * @description
 * The VoterCache schema provides a performance optimization by storing validation results
 * and voting power calculations to avoid redundant expensive operations.
 * When a voter is first validated against a ballot's requirements or has their voting power
 * calculated, the result is stored in this cache for quick retrieval in future requests.
 * This improves response times for ballot operations that require voter validation.
 * Composite indexes are maintained on voterId and ballotId for efficient lookups.
 * Timestamps are automatically managed to track creation and last update times.
 * The __v version key is removed from documents for cleaner output.
 */
const voterCacheSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Ballot",
    },
    voterId: {
      type: String,
      required: true,
      ref: "Voter",
    },
    validated: {
      type: Boolean,
      default: false,
    },
    votingPower: {
      type: Number,
      default: 0,
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
voterCacheSchema.index({ voterId: 1 });
voterCacheSchema.index({ ballotId: 1 });

// Pre-save middleware to update the updatedAt field
voterCacheSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const VoterCache = mongoose.model("VoterCache", voterCacheSchema);
export { VoterCache };
