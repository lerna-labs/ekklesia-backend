import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Proposal Schema
 * Represents a registered proposal for a ballot in the voting system
 *
 * @typedef {Object} Proposal
 * @property {ObjectId} ballotId - The ID of the ballot this proposal belongs to (references Ballot)
 * @property {String} title - The title of the proposal
 * @property {Object} data - Additional data related to the proposal (optional)
 * @property {Array} voteOptions - Available voting options for this proposal
 *                                 Default: [{id: 1, value: 1, label: "Yes"},
 *                                          {id: 2, value: -1, label: "No"},
 *                                          {id: 3, value: 0, label: "Abstain"}]
 * @property {Date} createdAt - Timestamp when the proposal was created (immutable)
 * @property {Date} updatedAt - Timestamp when the proposal was last updated
 *
 * @description
 * Proposals are items that voters can vote on within a ballot.
 * Each proposal belongs to a specific ballot and contains details about what's being voted on.
 * The schema includes configurable voting options with default Yes/No/Abstain values.
 * Timestamps are automatically managed to track creation and modification times.
 * Indexes are maintained on ballotId and name for efficient queries.
 * The __v version key is removed from documents for cleaner output.
 */
const proposalSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Ballot",
    },
    ipfsHash: {
      type: String,
      required: false,
      default: null, // Optional field for IPFS hash
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: false,
      default: "",
    },
    categories: {
      type: Array,
      required: false,
      default: [],
    },
    tags: {
      type: Array,
      required: false,
      default: [],
    },
    data: {
      type: Object,
      required: false,
    },
    voteType: {
      type: String,
      required: true,
      default: "default",// default, budget, ranked
    },
    voterBudget: {
      type: Number,
      required: false,
      default: 1,
    },
    voteOptions: {
      type: Array,
      required: true,
      default: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
        { id: 3, cost: 1, label: "Abstain" },
      ],
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
proposalSchema.index({ ballotId: 1 });
proposalSchema.index({ name: 1 });

// Pre-save middleware to update the updatedAt field
proposalSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Proposal = mongoose.model("Proposal", proposalSchema);
export { Proposal };
