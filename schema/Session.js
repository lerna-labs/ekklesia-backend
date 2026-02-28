import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Session Schema
 * Represents a login session and authentication state for a user
 *
 * @typedef {Object} Session
 * @property {String} userId - ID of the user attempting to log in (bech32 address: stake1..., drep1..., or pool1...)
 * @property {String} nonce - Challenge nonce for signature verification (null after use)
 * @property {Date} createdAt - Timestamp when the session was created (immutable)
 * @property {Date} updatedAt - Timestamp when the session was last updated
 *
 * @description
 * The Session schema manages authentication challenges for users.
 * When a user attempts to log in, a session is created with a random nonce that
 * the user must sign with their private key to prove identity.
 * Each user can have multiple sessions (e.g., from different devices or login attempts).
 * Sessions are typically short-lived and represent the authentication handshake process.
 * Nonces expire after 5 minutes and are set to null after successful authentication (single-use).
 * An index on userId is maintained for efficient lookup during the authentication flow.
 * Timestamps are automatically managed to track creation and verification times.
 * The __v version key is removed from documents for cleaner output.
 */
const sessionSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    nonce: {
      type: String,
      required: false, // Allow null after nonce is used (single-use nonces)
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
sessionSchema.index({ userId: 1 });
// TTL index to automatically delete sessions older than 1 hour (cleanup old nonces)
sessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

const Session = mongoose.model("Session", sessionSchema);
export { Session };
