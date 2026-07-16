import mongoose from 'mongoose';
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
 * @property {String} voteType - Type of voting system: "choice" (single-pick), "multi-choice" (pick min..max), "budget" (knapsack), "weighted" (point allocation), "ranked", "scale", or "likert" (default: "choice")
 * @property {Number} voteIncrement - Increment value for scale votes (default: 1, e.g., 1 for integer scale, 0.5 for half-point scale)
 * @property {Number} voterBudget - Budget limit for voters in budget vote type (default: 1, total cost cannot exceed this)
 * @property {Boolean} requireAnswer - When true, voters MAY NOT submit { abstain: true } on this question (they must pick a selection). Default false means abstain is allowed. Inverted from the legacy `abstainAllowed` field (dropped).
 * @property {Array<Object>} voteOptions - Available voting options for this proposal
 *                                        Default: [{id: 1, cost: 1, label: "Yes"}, {id: 2, cost: 1, label: "No"}]
 *                                        Required: id (integer), label (string ≤ 120).
 *                                        Optional: cost (number, default 1),
 *                                        description (string ≤ 1000 — voter-facing blurb),
 *                                        referenceUrl (string ≤ 500 — "learn more" link),
 *                                        imageUrl (string ≤ 500 — optional thumbnail),
 *                                        metadata (Object — free-form for one-off attributes
 *                                        the frontend understands, e.g. candidate platform).
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
      ref: 'Ballot',
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
      default: '',
      maxlength: 2000,
    },
    // Long-form argument for the proposal — typically the section a
    // voter reads before deciding. Capped per CompiledBallot
    // MAX.rationale (10k chars) to keep proposal docs bounded.
    rationale: {
      type: String,
      required: false,
      default: '',
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
      validate: [(arr) => arr.length <= 20, 'authors: max 20 entries'],
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
      // choice (single-pick — binary when 2 opts, single-choice otherwise),
      // multi-choice (pick min..max; uses minSelections/maxSelections),
      // budget (knapsack: Σ cost ≤ voterBudget, maps to Hydra multi-choice),
      // weighted (point allocation: Σ value = voterBudget, maps to Hydra
      // weighted), ranked, scale, likert.
      default: 'choice',
    },
    voteIncrement: {
      type: Number,
      required: false,
      default: 1,
    },
    // For likert vote type: the valid rating range for each option.
    // Voters rate every option independently within [min, max], snapped
    // to `step` (defaults to 1 — e.g. 1..5 by 1). Non-unit steps enable
    // coarse grids like 0..100 by 5. Hydra enforces
    // (max - min) % step === 0 at /prepare time.
    ratingRange: {
      type: new Schema(
        { min: Number, max: Number, step: { type: Number, default: 1 } },
        { _id: false },
      ),
      default: null,
    },
    voterBudget: {
      type: Number,
      required: false,
      default: 1,
    },
    // Count bounds for voteType:"multi-choice". minSelections defaults
    // to 1 (empty submissions rejected — voters use abstain to skip);
    // maxSelections defaults to voteOptions.length when unset. Ignored
    // for other voteTypes.
    minSelections: {
      type: Number,
      required: false,
      default: null,
    },
    maxSelections: {
      type: Number,
      required: false,
      default: null,
    },
    // Typed option subschema. `id` is Mixed to preserve backward
    // compatibility with the legacy `"abstain"` string sentinel;
    // production-authored ballots should use integer ids exclusively
    // (the abstain-as-option pattern has been superseded by the
    // top-level `abstain: true` flag at /draft).
    voteOptions: {
      type: [
        new Schema(
          {
            id: { type: Schema.Types.Mixed, required: true },
            label: { type: String, required: true, maxlength: 120 },
            // Only meaningful for voteType: "budget" (knapsack —
            // Σ cost ≤ voterBudget). Absent on every other voteType.
            // No default: we don't want to inject cost: 1 on every
            // choice / multi-choice / likert / etc. option.
            cost: { type: Number },
            description: { type: String, maxlength: 1000 },
            referenceUrl: { type: String, maxlength: 500 },
            imageUrl: { type: String, maxlength: 500 },
            metadata: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      required: true,
      default: [
        { id: 1, cost: 1, label: 'Yes' },
        { id: 2, cost: 1, label: 'No' },
      ],
    },
    // When true, voters MUST submit a selection — { abstain: true } is
    // rejected. Default false (permissive): abstain is allowed. This
    // replaces the legacy `abstainAllowed` field with opposite polarity
    // so the common case (abstain-allowed) needs no flag.
    requireAnswer: {
      type: Boolean,
      default: false,
    },
    // blake2b_256 hex of the canonical per-proposal content blob. Set by
    // `helper/proposalContent.js:ensureProposalContentHash()` whenever
    // the proposal is written/updated. Anchors the voter-facing content
    // (title, summary, rationale, options, images, URLs) so auditors
    // can cryptographically verify the proposal hasn't drifted since
    // ballot-prepare time. Exposed via
    // `GET /api/v1/ballots/:id/questions/:qid/content` and the archive
    // bundle; will be included in Hydra's BallotQuestion once the
    // middleware ships contentHash support.
    contentHash: {
      type: String,
      default: null,
    },
    // IPFS CID of the pinned content blob. Stays null until the IPFS
    // permanence track lands (see .claude/plans/ballot-content-permanence.md,
    // Track A). Content is still verifiable via contentHash + the
    // backend archive endpoint without a CID.
    contentCid: {
      type: String,
      default: null,
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
  },
);

// Indexes for faster queries
proposalSchema.index({ ballotId: 1 });
proposalSchema.index({ title: 1 });

const Proposal = mongoose.model('Proposal', proposalSchema);
export { Proposal };
