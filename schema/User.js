import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * User Schema
 * Stores display name and last login per voter (userId = _id).
 * _id is bech32 stake address, pool id or CIP129 drep/script id.
 */
const userSchema = new Schema(
  {
    _id: {
      type: String, // userId: bech32 stake address, cip129 drep id or bech32 pool id
      immutable: true,
    },
    name: {
      type: String, // drep name, pool ticker or handle
      required: false,
    },
    lastLogin: {
      type: Date,
      default: Date.now,
    },
    // Portable NativeScript JSON for script-based credentials (multisig
    // DReps, script stake keys, etc.). Fetched from Koios once at login
    // via @lerna-labs/ekklesia-helpers/cardano.getScript and cached here
    // — scripts are immutable on-chain so no TTL is needed. Null for
    // key-based voters.
    nativeScript: {
      type: Object,
      default: null,
    },
    // Last time the nativeScript was fetched. Informational; also used
    // as a cheap "have we tried before?" check to avoid re-fetching on
    // every login when a prior fetch failed (Koios 503, etc.).
    nativeScriptFetchedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const User = mongoose.model('User', userSchema);
export { User };
