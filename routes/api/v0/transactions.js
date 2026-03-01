// express router
import { Router } from "express";
const router = Router();

// schema
import { Transaction } from "../../../schema/Transaction.js";

// helper
import { isAuthenticated, getTransaction } from "../../../helper/middleWare.js";

/**
 * @route GET /api/v0/transactions
 * @description Get all transactions for the authenticated user, sorted by updatedAt (newest first)
 * @access Private (requires authentication)
 *
 * @returns {Array} 200 - Array of transaction objects for the authenticated user, each containing:
 *   - _id: MongoDB ObjectId of the transaction
 *   - userId: ID of the voter (matches authenticated user)
 *   - ballotId: ID of the ballot
 *   - merkleRoot: Merkle root hash of votes in transaction
 *   - votes: Object containing vote data for each proposal
 *   - status: Transaction status ("created", "pending", or "submitted")
 *   - signature: Signature object (null for multisig transactions)
 *   - multiSig: Array of signatures (empty for single-signature transactions)
 *   - txHash: Blockchain transaction hash (null if not yet submitted)
 *   - createdAt: ISO 8601 timestamp when transaction was created
 *   - updatedAt: ISO 8601 timestamp when transaction was last updated
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/", isAuthenticated, async (req, res) => {
  // get all transactions for the user
  const transactions = await Transaction.find({
    userId: req.userId,
  }).sort({
    updatedAt: -1,
  });

  return res.status(200).json(transactions);
});

/**
 * @route GET /api/v0/transactions/:transactionId
 * @description Get a specific transaction by ID for the authenticated user. Only returns transactions that belong to the authenticated user.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.transactionId - MongoDB ObjectId of the transaction to retrieve (validated by getTransaction middleware)
 *
 * @returns {Object} 200 - The transaction object containing all transaction fields (see GET /api/v0/transactions for structure)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if transaction not found or doesn't belong to the authenticated user
 */
router.get(
  "/:transactionId",
  isAuthenticated,
  getTransaction,
  async (req, res) => {
    if (req.transactionId) {
      const transaction = await Transaction.findOne({
        _id: req.transactionId,
        userId: req.userId,
      });
      if (!transaction) {
        return res.status(404).json({
          status: "error",
          message: "transaction not found",
        });
      }

      return res.status(200).json(transaction);
    }

    // get all transactions for the user
    const transactions = await Transaction.find({
      userId: req.userId,
    }).sort({
      updatedAt: -1,
    });

    return res.status(200).json(transactions);
  }
);

export default router;
