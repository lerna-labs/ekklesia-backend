import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * VotePackage Schema
 *
 * Aggregates the broker-side state for a single voter's vote on a Hydra ballot:
 * the unsigned signing payload, collected signatures (single-sig or m-of-n
 * multisig), and the Hydra confirmation artifacts once submitted.
 *
 * Replaces helper/createTransaction.js + schema/Transaction.js semantically,
 * but Transaction is kept intact for legacy-ballot archives.
 */
const votePackageSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Ballot",
    },
    userId: {
      type: String,
      required: true,
      ref: "Voter",
    },

    // Canonical signed-vote payload (matches Hydra SignedVotePayload).
    signingPayload: {
      type: Object,
      required: true,
    },
    // blake2b_256 of the canonical VoteEvidence JSON.
    voteHash: {
      type: String,
      default: null,
    },
    // Merkle proof materials (root + sibling steps) produced via hydra-proof.
    merkleProof: {
      type: Object,
      default: null,
    },
    // Nonce reserved for this package; must match Hydra voter-token Version on submission.
    nonce: {
      type: Number,
      required: true,
    },

    // Signature collection (1+ for multisig).
    signatures: {
      type: Array,
      default: [],
    },
    // Native script definition for script-based voters; null for key-based.
    nativeScript: {
      type: Object,
      default: null,
    },
    // CIP-151 calidus declaration when an SPO votes via a hot key.
    calidusDeclaration: {
      type: Object,
      default: null,
    },

    // Hydra confirmation artifacts.
    ipfsCid: {
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
    confirmedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: [
        "draft",
        "awaiting-signatures",
        "awaiting-submission",
        "broker-submitted",
        "hydra-confirmed",
        "failed",
        "cancelled",
        // Set by the staleVotePackageSweep cron or an explicit DELETE
        // when a voter walks away from an unfinished draft. Terminal —
        // NOT resumable. The nonce is released back to UserCache so the
        // next fresh draft reserves the same value (Hydra enforces
        // strict nonce === currentVersion + 1).
        "abandoned",
      ],
      default: "draft",
      required: true,
    },
    failureReason: {
      type: String,
      default: null,
    },
    // Stamped on every voter-initiated interaction (draft upsert,
    // signature append, submit attempt). Drives the TTL sweep —
    // packages in non-terminal status whose lastActivityAt is older
    // than VOTE_PACKAGE_TTL_MINUTES get transitioned to "abandoned"
    // and their nonce released. Distinct from Mongoose's automatic
    // `updatedAt` which mutates on every field touch; lastActivityAt
    // tracks only voter presence.
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

votePackageSchema.index({ userId: 1 });
votePackageSchema.index({ ballotId: 1 });
votePackageSchema.index({ status: 1 });
votePackageSchema.index({ ballotId: 1, userId: 1 });
// TTL sweep: cron queries for non-terminal packages past their
// lastActivityAt cutoff. Compound index keeps the scan fast.
votePackageSchema.index({ status: 1, lastActivityAt: 1 });

const VotePackage = mongoose.model("VotePackage", votePackageSchema);
export { VotePackage };
