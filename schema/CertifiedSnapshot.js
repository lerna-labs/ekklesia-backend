import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * CertifiedSnapshot Schema
 *
 * Append-only version history of voting-authority certifications for a
 * ballot. Each row captures a single publication from the authority —
 * either a full re-weighting of the tally (voting-power snapshot +
 * eligibility list) or a narrative-only endorsement of the existing
 * Hydra-final tally.
 *
 * Written by `helper/results/certify.js` at admin-ingest time and, in
 * a future iteration, by an on-chain metadata watcher that indexes
 * transactions originating from `Ballot.voteAuthorityAddress`. The same
 * ingest code path handles both sources — only the `source` +
 * `chainTxHash` fields discriminate.
 *
 * Versioning: monotonic `version` per ballot (1-indexed). Restatements
 * from the authority land as version N+1; identical payload bytes
 * short-circuit to the existing version (idempotent). Older versions
 * stay on disk for audit transparency.
 */
const certifiedSnapshotSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Ballot',
      index: true,
    },
    // Monotonic per ballot. Combined with ballotId, this is the unique
    // key consumers reference when pinning to a specific certified state.
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    // "api"   — admin POST /api/v1/admin/ballots/:id/certify
    // "chain" — future: on-chain metadata tx from voteAuthorityAddress
    source: {
      type: String,
      enum: ['api', 'chain'],
      required: true,
    },
    // Populated when source === "chain"; the L1 tx carrying the snapshot
    // metadata payload. Null for API-ingested rows.
    chainTxHash: {
      type: String,
      default: null,
    },
    // Admin user who posted the certification (JWT sub). For chain-sourced
    // rows, the pseudo-id "chain" is used.
    submittedBy: {
      type: String,
      required: true,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    // URL where the authority published the canonical snapshot file. When
    // the admin POSTs raw payload inline, this is null; when they POST a
    // URL pointer, the backend fetches + stores the URL here for auditor
    // use.
    snapshotUrl: {
      type: String,
      default: null,
    },
    // blake2b_256 of the canonical JSON bytes as received. Used for
    // idempotency (same hash → no-op re-ingest) and for operator trust
    // ("the bytes I see on the authority's site hash to what landed").
    snapshotHash: {
      type: String,
      default: null,
    },
    // True when only a narrative link was supplied (no voters[] payload).
    // In this mode `voters` is empty, `derivedPerProposal` is empty, and
    // the associated Result docs are NOT flipped to `source: "certified"`.
    // The narrative is still written to `Ballot.authorityNarrative` so
    // the frontend can link to the authority's announcement even when
    // re-weighting wasn't required.
    narrativeOnly: {
      type: Boolean,
      default: false,
    },
    // Informational, echoed from the authority payload for display.
    snapshotEpoch: {
      type: Number,
      default: null,
    },
    // Per-voter certified state. `votingPower` stored as a decimal string
    // for BigInt-safety (Mongo doubles can't represent all lovelace values
    // precisely). `eligible: false` excludes the voter from the tally
    // despite being in the snapshot. Voters in the snapshot but not in
    // the Hydra evidence are ignored; voters in the evidence but not in
    // the snapshot cause the ingest to reject.
    voters: {
      type: [
        new Schema(
          {
            voterId: { type: String, required: true },
            votingPower: { type: String, required: true },
            eligible: { type: Boolean, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    // Per-proposal re-derived tally, computed at ingest time by routing
    // the authority's `voters[]` through `helper/results/hydraTally.js`
    // `deriveProposalTally`. Keyed by stringified proposalId. Shape
    // matches `Result.results` + `Result.resultsByGroup` so downstream
    // reads are trivial.
    //
    // Empty object for narrative-only rows.
    derivedPerProposal: {
      type: Map,
      of: new Schema(
        {
          results: { type: Array, default: [] },
          resultsByGroup: { type: Object, default: {} },
          ballotParticipation: { type: Object, default: null },
          proposalParticipation: { type: Object, default: null },
        },
        { _id: false },
      ),
      default: () => new Map(),
    },
    // If the authority also published a narrative with this certification,
    // snapshot it here (mirrored to `Ballot.authorityNarrative` for fast
    // reads; kept per-version so we can display the narrative that was
    // live at a given certification step).
    narrative: {
      type: new Schema(
        {
          url: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

certifiedSnapshotSchema.index({ ballotId: 1, version: 1 }, { unique: true });

const CertifiedSnapshot = mongoose.model('CertifiedSnapshot', certifiedSnapshotSchema);
export { CertifiedSnapshot };
