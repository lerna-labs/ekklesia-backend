import mongoose from "mongoose";
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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const User = mongoose.model("User", userSchema);
export { User };
