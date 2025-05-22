import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Ballot Schema
 * Represents a registered ballot in the voting system
 *
 * @typedef {Object} Ballot
 * @property {String} name - Name of the ballot
 * @property {String} description - Description of the ballot
 * @property {String} voterType - Type of voters eligible for this ballot (e.g., 'stake', 'drep', 'pool')
 * @property {String} voterDescription - Human-readable description of eligible voters
 * @property {Boolean} voteWeighted - Whether votes are weighted by voter power (true) or counted equally (false)
 * @property {Number} voteThreshold - Minimum threshold required for vote acceptance (if applicable)
 * @property {Date} votePeriodStart - Start date and time of the voting period
 * @property {Date} votePeriodEnd - End date and time of the voting period
 * @property {Boolean} voteFilters - Whether filtering options are enabled for this ballot
 * @property {String} voteAuthorityId - ID of the voting authority managing this ballot
 * @property {String} voteAuthorityAddress - Blockchain address of the voting authority
 * @property {Date} proposalPeriodStart - Start date and time for submitting proposals
 * @property {Date} proposalPeriodEnd - End date and time for submitting proposals
 * @property {String} resultBeaconToken - Token for the result beacon (null if not finalized)
 * @property {String} voterValidationScript - Script used to validate voters (default: voterValidationAlwaysTrue.js)
 * @property {String} rollupScript - Script used to calculate voting results (default: rollupBallot.js)
 * @property {Date} createdAt - Timestamp when the ballot was created (immutable)
 * @property {Date} updatedAt - Timestamp when the ballot was last updated
 * @property {String} status - Virtual property indicating ballot status ("live", "closed", or "upcoming")
 */
const ballotSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
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
    voteThreshold: {
      type: Number,
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
    resultBeaconToken: {
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
ballotSchema.index({ name: 1 });
ballotSchema.index({ voterType: 1 });

// Replace is_live with a more descriptive status virtual property
ballotSchema.virtual("status").get(function () {
  const currentDate = new Date();
  const voteStart = new Date(this.votePeriodStart);
  const voteEnd = new Date(this.votePeriodEnd);

  // !! need to implement results pending for non-public ballots
  if (currentDate > voteEnd) {
    return "closed"; // Voting period has ended
  } else if (currentDate >= voteStart && currentDate <= voteEnd) {
    return "live"; // Currently in voting period
  } else {
    return "upcoming"; // Voting period has not started yet
  }
});

// Pre-save middleware to update the updatedAt field
ballotSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Ballot = mongoose.model("Ballot", ballotSchema);
export { Ballot };
