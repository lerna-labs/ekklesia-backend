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
 * @property {String} summary - Short pitch shown in lists and summary cards (max 2000 chars)
 * @property {String} rationale - Long-form argument for the proposal (max 10000 chars)
 * @property {Array<{name: String}>} authors - Proposer / submitter display names (max 20 entries, 120 chars each)
 * @property {String} version - Source-system version tag (e.g. "v2.3", "draft")
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
    // Short pitch shown in proposal lists / summary cards. Pairs with
    // `rationale` (the long-form case for the proposal). The legacy
    // `description` field was dropped — if you need to ingest legacy
    // data, copy description → summary at the import boundary.
    summary: {
      type: String,
      required: false,
      default: "",
      maxlength: 2000,
    },
    // Long-form argument for the proposal — typically the section a
    // voter reads before deciding. Capped per CompiledBallot
    // MAX.rationale (10k chars) to keep proposal docs bounded.
    rationale: {
      type: String,
      required: false,
      default: "",
      maxlength: 10000,
    },
    // Proposer / submitter names. Each entry is a free-form display
    // string (no relation to userId). Capped at 20 authors × 120
    // chars each per CompiledBallot MAX.
    authors: {
      type: [
        {
          _id: false,
          name: { type: String, required: true, maxlength: 120 },
        },
      ],
      default: [],
      validate: [(arr) => arr.length <= 20, "authors: max 20 entries"],
    },
    // Source-system version tag (e.g. "v2.3", "draft"). Useful for
    // showing "updated since import" badges when a snapshot drifts.
    version: {
      type: String,
      required: false,
      default: null,
      maxlength: 40,
    },
    // categories + tags were dropped — per-ballot Ballot.facets[]
    // serves the same purpose with stronger typing (enum/number/etc),
    // is declared once per ballot rather than free-form per proposal,
    // and avoids the "ballot has no use for categories" mismatch.
    // Per-proposal facet values live on
    // externalProposal.snapshot.facets keyed by Ballot.facets[].key.
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
    // Null for fully local proposals.
    //
    // `snapshot` is a frozen-at-import copy of the upstream payload —
    // useful for drift detection ("source has updated since import")
    // and audit. The local first-class fields (title, description,
    // summary, rationale, authors, version) are the canonical source
    // for display; snapshot is for audit only.
    //
    // `snapshot.facets` is a dict keyed by Ballot.facets[].key;
    // multi-value enums use CSV strings.
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
