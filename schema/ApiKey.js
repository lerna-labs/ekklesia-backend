import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * ApiKey Schema
 *
 * Integrator API keys for the public `/api/v1/public/*` surface. Phase 6
 * ships manual issuance (admin tool / script); a full self-serve portal is
 * out of scope for this plan. Keys are stored hashed (SHA-256) so the
 * plain-text secret is only visible at issuance time.
 */
const apiKeySchema = new Schema(
  {
    // Human-readable label for the consumer (org/project name).
    label: {
      type: String,
      required: true,
    },
    // Contact (email/slack) for rotation notices.
    contact: {
      type: String,
      default: null,
    },
    // SHA-256 hex digest of the issued key. Plain-text key is not stored.
    keyHash: {
      type: String,
      required: true,
      unique: true,
    },
    // Prefix shown in logs/UI to identify the key without revealing it.
    keyPrefix: {
      type: String,
      required: true,
    },
    // Optional rate bucket override; null → env defaults apply.
    rateLimit: {
      windowMs: { type: Number, default: null },
      max: { type: Number, default: null },
    },
    // Simple scope string array — "read:ballots", "read:results", etc.
    scopes: {
      type: [String],
      default: ["read:ballots", "read:results"],
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

apiKeySchema.index({ enabled: 1 });

const ApiKey = mongoose.model("ApiKey", apiKeySchema);
export { ApiKey };
