import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Ballot Schema
 * Represents a registered ballot in the voting system
 *
 * @typedef {Object} Ballot
 * @property {String} title - Title of the ballot
 * @property {String} description - Description of the ballot
 * @property {String} ipfsHash - IPFS hash of the ballot metadata (optional, null if not stored on IPFS)
 * @property {String} voterType - Type of voters eligible for this ballot (e.g., 'stake', 'drep', 'pool')
 * @property {String} voterDescription - Human-readable description of eligible voters
 * @property {Boolean} voteWeighted - Whether the voting is weighted (default: false) - needed for UI displays mainly
 * @property {Date} votePeriodStart - Start date and time of the voting period
 * @property {Boolean} voteFilters - Whether filtering options are enabled for this ballot (default: false)
 * @property {Date} votePeriodEnd - End date and time of the voting period
 * @property {String} voteAuthorityId - ID of the voting authority managing this ballot
 * @property {String} voteAuthorityAddress - Blockchain address of the voting authority
 * @property {Date} proposalPeriodStart - Start date and time for submitting proposals
 * @property {Date} proposalPeriodEnd - End date and time for submitting proposals
 * @property {String} resultTxHash - Token for the result transaction (null if not finalized)
 * @property {String} voterValidationScript - Script used to validate voters (default: voterValidationAlwaysTrue.js)
 * @property {String} rollupScript - Script used to calculate voting results (default: rollupBallot.js)
 * @property {String} startupScript - Script used to start the ballot (default: startupBallot.js)
 * @property {Date} startupAt - Timestamp when the ballot was started (optional, null if not started)
 * @property {String} status - Current ballot status: "upcoming", "live", or "closed" (default: "upcoming")
 * @property {Date} createdAt - Timestamp when the ballot was created (immutable)
 * @property {Date} updatedAt - Timestamp when the ballot was last updated
 */
const ballotSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    ipfsHash: {
      type: String,
      required: false,
      default: null, // Optional field for IPFS hash
    },
    voterType: {
      type: String,
      required: true,
    },
    voterDescription: {
      type: String,
      required: true,
    },
    voteWeighted: {
      type: Boolean,
      default: false,
      required: true,
    },
    votePeriodStart: {
      type: Date,
      required: true,
    },
    voteFilters: {
      type: Boolean,
      default: false,
      required: true,
    },
    votePeriodEnd: {
      type: Date,
      required: true,
    },
    voteAuthorityId: {
      type: String,
      required: true,
    },
    voteAuthorityAddress: {
      type: String,
      required: true,
    },
    proposalPeriodStart: {
      type: Date,
      required: true,
    },
    proposalPeriodEnd: {
      type: Date,
      required: true,
    },
    resultTxHash: {
      default: null,
      type: String,
    },
    voterValidationScript: {
      type: String,
      default: "voterValidationAlwaysTrue.js",
      required: true,
    },
    rollupScript: {
      type: String,
      default: "rollupBallot.js",
      required: true,
    },
    startupScript: {
      type: String,
      default: "startupBallot.js",
      required: true,
    },
    startupAt: {
      type: Date,
      required: false,
      default: null,
    },
    status: {
      type: String,
      enum: ["upcoming", "live", "closed"],
      default: "upcoming",
      required: true,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Include virtuals when converting to JSON, exclude id virtual
    toObject: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Include virtuals when converting to plain objects, exclude id virtual
  }
);

// Indexes for faster queries
ballotSchema.index({ title: 1 });
ballotSchema.index({ voterType: 1 });

const Ballot = mongoose.model("Ballot", ballotSchema);
export { Ballot };
