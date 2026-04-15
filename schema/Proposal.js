import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Proposal Schema
 * Represents a registered proposal for a ballot in the voting system
 *
 * @typedef {Object} Proposal
 * @property {ObjectId} ballotId - The ID of the ballot this proposal belongs to (references Ballot)
 * @property {String} ipfsHash - IPFS hash of the proposal metadata (optional, null if not stored on IPFS)
 * @property {String} title - The title of the proposal
 * @property {String} description - Detailed description of the proposal content (default: empty string)
 * @property {Array<String>} categories - Array of category labels for organizing proposals (default: empty array)
 * @property {Array<String>} tags - Array of tag labels for filtering and searching proposals (default: empty array)
 * @property {Object} data - Additional structured data related to the proposal (optional, format varies by proposal type)
 * @property {String} voteType - Type of voting system: "default", "budget", "ranked", "scale", or "preference" (default: "default")
 * @property {Number} voteIncrement - Increment value for scale votes (default: 1, e.g., 1 for integer scale, 0.5 for half-point scale)
 * @property {Number} voterBudget - Budget limit for voters in budget vote type (default: 1, total cost cannot exceed this)
 * @property {Boolean} abstainAllowed - Whether voters can select an "abstain" option (default: true, abstain cannot be combined with other votes)
 * @property {Array<Object>} voteOptions - Available voting options for this proposal
 *                                        Default: [{id: 1, cost: 1, label: "Yes"}, {id: 2, cost: 1, label: "No"}]
 *                                        Each option has: id (number or "abstain" string), cost (number), label (string)
 * @property {Date} createdAt - Timestamp when the proposal was created (immutable)
 * @property {Date} updatedAt - Timestamp when the proposal was last updated
 *
 * @description
 * Proposals are items that voters can vote on within a ballot.
 * Each proposal belongs to a specific ballot and contains details about what's being voted on.
 * The schema includes configurable voting options and supports multiple vote types including
 * default (Yes/No), budget (with cost constraints), ranked, scale (numeric range), and preference voting.
 * Timestamps are automatically managed to track creation and modification times.
 * Indexes are maintained on ballotId and title for efficient queries.
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
      default: "default",// default, budget, ranked, scale, preference
    },
    voteIncrement: {
      type: Number,
      required: false,
      default: 1,
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
      ],
    },
    abstainAllowed: {
      type: Boolean,
      required: true,
      default: true,
    },
    // Back-reference to the originating proposal in an upstream
    // proposals module (populated by the compiled-ballot importer).
    // Null for scaffold-created / legacy proposals. The `snapshot`
    // carries a whitelisted, length-capped copy of upstream display
    // fields so the voting UX can render without live-fetching the
    // proposals module — and cannot be broken by arbitrary upstream
    // data shapes. `snapshot.facets` is a dict keyed by
    // `Ballot.facets[].key`; multi-value enums use CSV strings.
    externalProposal: {
      type: {
        _id: false,
        id: { type: String, required: true },
        url: { type: String, default: null },
        snapshot: { type: Object, default: null },
      },
      default: null,
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
proposalSchema.index({ title: 1 });

const Proposal = mongoose.model("Proposal", proposalSchema);
export { Proposal };
