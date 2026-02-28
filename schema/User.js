import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * User Schema
 * Stores display name and last login per voter (voterId = _id).
 * _id is bech32 stake address or CIP129 drep/script id.
 */
const userSchema = new Schema(
  {
    _id: {
      type: String, // voterId: bech32 stake address or cip129 drep id
      immutable: true,
    },
    name: {
      type: String, // drep name or handle
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
