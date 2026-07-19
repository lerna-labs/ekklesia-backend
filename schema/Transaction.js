import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * Transaction Schema
 * Represents a transaction for submitting votes in the voting system
 *
 * @typedef {Object} Transaction
 * @property {ObjectId} ballotId - The ID of the ballot associated with this transaction (references Ballot)
 * @property {String} userId - The ID of the voter associated with this transaction (references Voter)
 * @property {String} txHash - The transaction hash after submission to blockchain (optional)
 * @property {Object} signature - The signature object for transaction verification (optional)
 * @property {Array} multiSig - Array of signatures for multisig transactions (optional)
 * @property {Object} votes - Collection of votes associated with this transaction
 * @property {String} merkleRoot - The Merkle root hash for verifying vote integrity
 * @property {String} status - Current status of the transaction ("created", "pending", or "submitted")
 * @property {Date} createdAt - Timestamp when the transaction was created (immutable)
 * @property {Date} updatedAt - Timestamp when the transaction was last updated
 *
 * @description
 * The Transaction schema represents batched votes ready for submission to the blockchain.
 * It tracks the state of vote submissions from initial creation through signature verification
 * to final submission. Transactions may require single signatures or multiple signatures
 * (via the multiSig array) depending on the voter type.
 * Indexes are maintained on userId, ballotId, and status for efficient queries.
 * Timestamps are automatically managed to track creation and last update times.
 * The __v version key is removed from documents for cleaner output.
 */
const transactionSchema = new Schema(
  {
    ballotId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Ballot',
    },
    userId: {
      type: String,
      required: true,
      ref: 'Voter',
    },
    txHash: {
      type: String,
      required: false,
    },
    signature: {
      type: Object,
      required: false,
    },
    multiSig: {
      type: Array,
      required: false,
    },
    votes: {
      type: Object,
      required: true,
    },
    merkleRoot: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['created', 'pending', 'submitted'],
      default: 'created',
      required: true,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
  },
);

// Indexes for faster queries
transactionSchema.index({ userId: 1 });
transactionSchema.index({ ballotId: 1 });
transactionSchema.index({ status: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
export { Transaction };
