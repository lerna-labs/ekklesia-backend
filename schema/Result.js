import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Result Schema
 * Represents the voting results for a specific proposal
 *
 * @typedef {Object} Result
 * @property {ObjectId} proposalId - The ID of the proposal these results belong to (references Proposal)
 * @property {Object} results - Object containing the calculated voting results
 * @property {Object} [resultsByGroup] - Optional results per voterGroup: { "<group>": { results: [{ id, label, count, votingPower }], totalVotes } }
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
    resultsByGroup: {
      type: Object,
      required: false,
    },
    source: {
      type: String,
      // "provisional"  — anything before authority certification. Covers
      //                  both the live-cron tally and the Hydra-final
      //                  tally (written at /settle/finalize).
      // "certified"    — an authority-published CertifiedSnapshot has
      //                  re-weighted the tally with audited voting power.
      // "final" (legacy) — kept for backwards compatibility with pre-
      //                  certification docs; mapped to "provisional" at
      //                  read time by the /certified endpoint.
      enum: ["provisional", "final", "certified"],
      default: "provisional",
    },
    ballotSource: {
      type: String,
      enum: ["legacy", "hydra"],
      default: "legacy",
    },
    ballotId: {
      type: Schema.Types.ObjectId,
      ref: "Ballot",
      required: false,
    },
    finalizedAt: {
      type: Date,
      default: null,
    },
    // Ballot-level participation snapshot taken at result-write time.
    // Per-group sum of voting power AND voter count for everyone who
    // cast at least one vote on ANY proposal in the parent ballot
    // (not necessarily this proposal). The denominator authorities
    // typically use for "X% of participating stake voted Yes" thresholds.
    //
    // Shape: {
    //   totalVotingPower: { drep: <lovelace>, pool: <lovelace>, default: <lovelace> },
    //   voterCount:       { drep: <int>,      pool: <int>,      default: <int>      }
    // }
    // Only present groups are included (per ballot-level convention).
    ballotParticipation: {
      type: Object,
      default: null,
    },
    // Per-proposal participation snapshot taken at result-write time.
    // Same shape as ballotParticipation but scoped to THIS proposal:
    // distinct voters who cast at least one vote here. Frontends
    // compute "X% of ballot voters engaged with this question" via
    // proposalParticipation / ballotParticipation. Distinct from
    // result.totalVotes / resultsByGroup[g].totalVotes which can
    // over-count when a voter selects multiple targets in one vote
    // (budget, ranked).
    proposalParticipation: {
      type: Object,
      default: null,
    },
    // Per-group count + voting power of voters who are in the ballot-wide
    // participation pool (`ballotParticipation`: cast ≥1 non-abstain vote
    // anywhere on the ballot) AND explicitly abstained on THIS proposal.
    //
    // This is the *intersection* — NOT every abstainer on the proposal. A
    // voter who abstained on everything is never in the pool, so subtracting
    // them would shrink a denominator they were never part of. The frontend's
    // participation-mode denominator is therefore:
    //   ballotParticipation.voterCount[g] − participatingAbstainers.voterCount[g]
    // (and the votingPower analog for weighted ballots). The same number is
    // the "Abstain" cohort the UI shows, so the four cohorts partition the
    // pool exactly. Emitted on every ballot regardless of
    // `resultsCalculationMode`; "standard"-mode frontends simply ignore it.
    //
    // Shape mirrors ballotParticipation:
    //   { totalVotingPower: { <group>: <number> }, voterCount: { <group>: <int> } }
    participatingAbstainers: {
      type: Object,
      default: null,
    },
    hydraEvidenceCid: {
      type: String,
      default: null,
    },
    // blake2b_256 of the canonical results JSON; anchored on the (601)
    // datum so auditors can verify the pinned results match on-chain.
    hydraResultsHash: {
      type: String,
      default: null,
    },
    // Merkle root over the per-voter evidence files in the IPFS directory.
    hydraEvidenceMerkleRoot: {
      type: String,
      default: null,
    },
    // IPFS CID of the compact results JSON (distinct from the full
    // evidence directory).
    hydraResultsCid: {
      type: String,
      default: null,
    },
    // Count of voter tokens included in the final tally (from Hydra).
    hydraTotalVoters: {
      type: Number,
      default: null,
    },
    // Voter tokens excluded from the tally (evidence mismatch / missing).
    hydraExcludedVoters: {
      type: Array,
      default: [],
    },
    // Timestamp when /settle/finalize populated the Hydra-provenance
    // fields above. Distinct from `certifiedAt` (below): Hydra-finalized
    // means "the head's cryptographic record is closed and anchored on
    // chain"; certification is the separate authority step.
    hydraFinalizedAt: {
      type: Date,
      default: null,
    },
    // Authority-certified-results fields. Populated by
    // POST /api/v1/admin/ballots/:id/certify when the voting authority
    // ingests an audited voting-power + eligibility snapshot. The same
    // Hydra per-voter evidence (unchanged) is re-derived through the
    // existing per-ballot helpers with the authority's snapshot as the
    // votersByUserId input, yielding a second set of counts/groups that
    // honor the authoritative voting power.
    certifiedResults: {
      type: Array,
      default: null,
    },
    certifiedResultsByGroup: {
      type: Object,
      default: null,
    },
    // Ref to the currently-active CertifiedSnapshot row. History stays
    // on the CertifiedSnapshot collection; this field always points at
    // the newest version.
    certifiedSnapshotId: {
      type: Schema.Types.ObjectId,
      ref: "CertifiedSnapshot",
      default: null,
    },
    certifiedVersion: {
      type: Number,
      default: null,
    },
    certifiedAt: {
      type: Date,
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

const Result = mongoose.model("Result", resultSchema);
export { Result };
