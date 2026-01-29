import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Session Schema
 * Represents a login session and authentication state for a voter
 *
 * @typedef {Object} Session
 * @property {String} voterId - ID of the voter attempting to log in (can be standard address or multisig script address)
 * @property {String} nonce - Challenge nonce for signature verification (null after successful login)
 * @property {Date} createdAt - Timestamp when the session was created (immutable)
 * @property {Date} updatedAt - Timestamp when the session was last updated (updated when nonce is cleared after login)
 *
 * @description
 * The Session schema manages authentication challenges for voters.
 * When a voter attempts to log in, a session is created with a random nonce that
 * the voter must sign with their private key to prove identity.
 * After successful signature verification and JWT token issuance, the nonce is set to null
 * but the session record remains for tracking login history.
 * Each voter can have multiple sessions (e.g., from different devices or login attempts).
 * Sessions are typically short-lived and represent the authentication handshake process.
 * For multisig wallets, the voterId is the CIP129 script address.
 * An index on voterId is maintained for efficient lookup during the authentication flow.
 * Timestamps are automatically managed to track creation and verification times.
 * The __v version key is removed from documents for cleaner output.
 */
const sessionSchema = new Schema(
  {
    voterId: {
      type: String,
      required: true,
    },
    nonce: {
      type: String,
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
  }
);

// Indexes for faster queries
sessionSchema.index({ voterId: 1 });

// Pre-save middleware to update the updatedAt field
sessionSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Session = mongoose.model("Session", sessionSchema);
export { Session };
