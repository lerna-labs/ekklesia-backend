// express router
import { Router } from "express";
const router = Router();

// schema
import { Transaction } from "../../../schema/Transaction.js";

// helper
import { isAuthenticated, getTransaction } from "../../../helper/middleWare.js";

/**
 * @route GET /api/v0/transactions
 * @description Get all transactions for the authenticated user
 * @access Private (requires authentication)
 *
 * @returns {Array} 200 - List of transactions for the user sorted by update time (descending)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/", isAuthenticated, async (req, res) => {
  // get all transactions for the user
  const transactions = await Transaction.find({
    voterId: req.voterId,
  }).sort({
    updatedAt: -1,
  });

  return res.status(200).json(transactions);
});

/**
 * @route GET /api/v0/transactions/:transactionId
 * @description Get a specific transaction by ID for the authenticated user
 * @access Private (requires authentication)
 *
 * @param {string} req.params.transactionId - ID of the transaction to retrieve
 *
 * @returns {Object} 200 - The requested transaction object or all user transactions if no specific transaction found
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if transaction not found or doesn't belong to the user
 */
router.get(
  "/:transactionId",
  isAuthenticated,
  getTransaction,
  async (req, res) => {
    if (req.transactionId) {
      const transaction = await Transaction.findOne({
        _id: req.transactionId,
        voterId: req.voterId,
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
      voterId: req.voterId,
    }).sort({
      updatedAt: -1,
    });

    return res.status(200).json(transactions);
  }
);

export default router;
