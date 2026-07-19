import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * Vote Schema
 * Represents a vote cast by a voter for a specific proposal within a ballot
 *
 * @typedef {Object} Vote
 * @property {String} userId - ID of the voter who cast the vote (references Voter, format depends on voterType)
 * @property {ObjectId} ballotId - ID of the ballot the vote belongs to (references Ballot)
 * @property {ObjectId} proposalId - ID of the proposal being voted on (references Proposal)
 * @property {Array<Number|String>} vote - Current value of the vote (may differ from submittedVote if changed)
 *                                        Array of vote option IDs (numbers) or "abstain" string.
 *                                        For scale votes, contains the numeric value.
 *                                        For budget votes, contains multiple option IDs that fit within voter's budget.
 * @property {Array<Number|String>} submittedVote - Value of the vote when it was last submitted via transaction
 *                                                  Array of vote option IDs that were submitted (numbers) or "abstain" string.
 *                                                  Null if the vote has never been submitted.
 * @property {Date} submittedAt - Timestamp when the vote was last submitted via transaction (null if never submitted)
 * @property {Date} createdAt - Timestamp when the vote was first created (immutable)
 * @property {Date} updatedAt - Timestamp when the vote was last updated (changes when vote value is modified)
 *
 * @description
 * The Vote schema represents individual votes cast by voters on specific proposals.
 * Each vote links a voter to their choice on a particular proposal within a ballot.
 * Votes can exist in two states: pending (not yet submitted) and submitted.
 * When votes are submitted via transaction, the submittedVote and submittedAt fields are updated.
 * If a voter changes their vote before submission, only the vote field changes.
 * Each voter can only have one vote per proposal (enforced by unique index on proposalId + userId).
 * Composite indexes are maintained for efficient querying by userId, proposalId, and ballotId.
 * Timestamps are automatically managed to track creation and modification times.
 * The __v version key is removed from documents for cleaner output.
 */
const voteSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      ref: 'Voter',
    },
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Ballot',
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Proposal',
    },
    vote: {
      type: Array,
      required: true,
    },
    submittedVote: {
      type: Array,
      required: false,
    },
    submittedAt: {
      type: Date,
      required: false,
    },
    // Hydra integration fields — null for legacy votes.
    nonce: {
      type: Number,
      default: null,
    },
    voteHash: {
      type: String,
      default: null,
    },
    hydraTxId: {
      type: String,
      default: null,
    },
    hydraProof: {
      type: Object,
      default: null,
    },
    ipfsCid: {
      type: String,
      default: null,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    signatures: {
      type: Array,
      default: [],
    },
    status: {
      type: String,
      enum: [
        'legacy',
        'draft',
        'awaiting-signatures',
        'awaiting-submission',
        'broker-submitted',
        'hydra-confirmed',
        'failed',
      ],
      default: 'legacy',
    },
    // Operator-driven soft exclusion. When `excludedAt` is non-null,
    // every results-derivation path (provisional cron, participation
    // helpers, v0 proposals fallback aggregations) filters this row
    // out via `{ excludedAt: null }`. Voter-facing reads (their own
    // submitted vote, vote-edit endpoints) deliberately ignore the
    // flag — the voter's own record is preserved.
    //
    // Used to clean up after operator mistakes such as a misconfigured
    // `voterValidationScript` that admitted ineligible voters. The
    // Hydra audit record is NOT mutated; final-tally + authority-
    // certification paths re-derive from Hydra evidence and the
    // authority's snapshot respectively, so the same voter is dropped
    // there via the certification flow rather than this flag.
    //
    // Flip via `__scripts/excludeVote.js` (no admin endpoint — this is
    // a manual-correction tool, not a hot path).
    excludedAt: {
      type: Date,
      default: null,
    },
    excludedReason: {
      type: String,
      default: null,
    },
    excludedBy: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
  },
);

// Indexes for faster queries
voteSchema.index({ userId: 1 });
voteSchema.index({ proposalId: 1 });
voteSchema.index({ ballotId: 1 });
voteSchema.index({ proposalId: 1, userId: 1 }, { unique: true });
voteSchema.index({ ballotId: 1, status: 1 });

const Vote = mongoose.model('Vote', voteSchema);
export { Vote };
