// express router
import { Router } from "express";
const router = Router();

// schema
import { Session } from "../../../schema/Session.js";
import { Ballot } from "../../../schema/Ballot.js";
import { Vote } from "../../../schema/Vote.js";
import { VoterCache } from "../../../schema/VoterCache.js";
import { Transaction } from "../../../schema/Transaction.js";
import { checkVotingPower } from "../../../helper/voterValidation.js";

// helper
import { stringToHex } from "@meshsdk/common";
import {
  verifySignature,
  validateScriptSignatures,
  isPartyToScript,
} from "../../../helper/verifySignature.js";
import { validateAddress } from "../../../helper/validateAddress.js";
import { getVotes, getPendingVoteCount } from "../../../helper/getVotes.js";
import { createTransaction } from "../../../helper/createTransaction.js";
import { PublicKey } from "@emurgo/cardano-serialization-lib-nodejs";
import { isAuthenticated, getBallot } from "../../../helper/middleWare.js";
import { fetchCalidusKey } from "../../../helper/koios.js";

/**
 * @route GET /api/v0/dashboard
 * @description Get authenticated voter stats including last login time, multisig status, and pending votes count
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - Voter information object containing:
 *   - userId: ID of the authenticated voter
 *   - lastLogin: ISO 8601 timestamp of last login (null if never logged in, from most recent Session record)
 *   - multiSig: Boolean indicating if voter is using multisig authentication
 *   - pendingVotesCount: Number of pending (unsubmitted) votes for the voter
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/", isAuthenticated, async (req, res) => {
  const userId = req.userId;

  // get last login timestamp
  const lastLogin = await Session.findOne({ userId }).sort({
    updatedAt: -1,
  });

  // check for pending votes
  const pendingVotesCount = await getPendingVoteCount(userId);

  return res.status(200).json({
    userId,
    lastLogin: lastLogin ? lastLogin.updatedAt : null,
    multiSig: req.multiSig,
    pendingVotesCount,
  });
});

/**
 * @route GET /api/v0/dashboard/ballots
 * @description Get all ballots the authenticated voter can vote on or has already voted on. Includes ballots the voter has already voted on plus live ballots where the voter is validated. Results are sorted by votePeriodStart (earliest first).
 * @access Private (requires authentication)
 *
 * @returns {Array} 200 - Array of ballot objects, each containing:
 *   - _id: MongoDB ObjectId of the ballot
 *   - title: Title of the ballot
 *   - description: Description of the ballot
 *   - voterType: Type of voters eligible for this ballot
 *   - status: Ballot status ("live", "closed", or "upcoming")
 *   - votePeriodStart: ISO 8601 timestamp when voting period starts
 *   - votePeriodEnd: ISO 8601 timestamp when voting period ends
 *   - voteWeighted: Boolean indicating if votes are weighted
 *   - votingPower: Number representing voter's voting power for this ballot (0 if no voting power)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/ballots", isAuthenticated, async (req, res) => {
  const userId = req.userId;
  // get all ballots the voter has already voted on
  const votedBallots = await Vote.find({ userId }).distinct("ballotId");

  // get all live ballots and validate voter against their respective voter validation
  const liveBallots = await Ballot.find({
    status: "live",
  }).distinct("_id");
  // filter out ballots the user has already voted on
  const ballotsToValidate = liveBallots.filter(
    (ballot) => !votedBallots.includes(String(ballot))
  );

  // validate voter on remaining ballots
  let voterBallots = votedBallots;
  let voterVotingPower = [];
  for (let ballotId of ballotsToValidate) {
    // get the ballot
    const ballot = await Ballot.findById(ballotId);

    const { validateVoter } = await import(
      "../../../config/" + ballot.voterValidationScript
    );
    // validate voter against ballot
    const isValidVoter = await validateVoter(userId, ballotId);
    if (isValidVoter) {
      // get voting power for the voter
      const weight = await checkVotingPower(userId, ballotId);
      if (weight) {
        // add voting power to the list
        voterVotingPower.push({
          ballotId,
          weight,
        });
      }
      // add ballotId to the list of ballots the voter can vote on
      voterBallots.push(ballotId);
    }
  }

  // get all ballots in voterBallots for output
  const ballots = await Ballot.find({
    _id: { $in: voterBallots },
  }).select(
    "_id title description voterType status votePeriodStart voteWeighted votePeriodEnd"
  );

  // add voting power to the ballots
  for (let i = 0; i < ballots.length; i++) {
    const ballot = ballots[i];
    const votingPower = voterVotingPower.find(
      (votingPower) => String(votingPower.ballotId) === String(ballot._id)
    );
    if (votingPower) {
      ballots[i] = {
        ...ballot.toObject(),
        votingPower: votingPower.weight,
      };
    } else {
      ballots[i] = {
        ...ballot.toObject(),
        votingPower: 0,
      };
    }
  }
  // sort ballots by votePeriodStart
  ballots.sort((a, b) => {
    return new Date(a.votePeriodStart) - new Date(b.votePeriodStart);
  });

  return res.status(200).json(ballots);
});

/**
 * @route GET /api/v0/dashboard/pending
 * @description Get all pending (unsubmitted) votes for the authenticated voter. Pending votes are votes that have been created but not yet submitted via transaction.
 * @access Private (requires authentication)
 *
 * @returns {Object|Array} 200 - Response containing:
 *   - If pending votes exist: Array of vote objects, each containing:
 *     - _id: MongoDB ObjectId of the vote
 *     - userId: ID of the voter
 *     - ballotId: ID of the ballot
 *     - proposalId: ID of the proposal
 *     - vote: Array of current vote option IDs
 *     - submittedVote: null (not yet submitted)
 *     - submittedAt: null (not yet submitted)
 *     - createdAt: ISO 8601 timestamp when vote was created
 *     - updatedAt: ISO 8601 timestamp when vote was last updated
 *   - If no pending votes: Object with message: "no pending votes"
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/pending", isAuthenticated, async (req, res) => {
  const userId = req.userId;

  const pendingVotes = await getVotes(userId, false, "pending", true);
  if (pendingVotes.length === 0) {
    return res.status(200).json({
      message: "no pending votes",
    });
  }

  return res.status(200).json(pendingVotes);
});

/**
 * @route POST /api/v0/dashboard/:ballotId/checkout
 * @description Request checkout for a ballot, creating transaction data for signing. Creates a transaction object containing all pending votes for the ballot, generates a merkle root, and returns hex-encoded data ready for signing. The signerAddress must match the authenticated userId.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - MongoDB ObjectId of the ballot to checkout
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer (must match authenticated userId, validated and converted to CIP129 if applicable)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (used for address validation and Calidus key lookup)
 *
 * @returns {Object} 200 - TransactionResponse object containing:
 *   - _id: MongoDB ObjectId of the transaction
 *   - userId: ID of the voter
 *   - ballotId: ID of the ballot
 *   - merkleRoot: Merkle root hash of all votes in transaction
 *   - votes: Object containing vote data for each proposal
 *   - dataHex: Hex-encoded merkle root (this is what the voter signs)
 *   - userIdHex: Hex-encoded signer address
 *   - calidusID: Calidus ID for pool signers (only present when signType is "pool")
 * @returns {Object} 400 - Error if:
 *   - Ballot status is not "live"
 *   - signerAddress is missing
 *   - signType is missing
 *   - Address validation fails
 *   - Signer address does not match authenticated userId
 *   - Pool not found or no calidus key registered (for pool signType)
 *   - Voter is not validated/allowed to vote on this ballot (not in VoterCache or validated=false)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.post(
  "/:ballotId/checkout/",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    const userId = req.userId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "Checkout attempt (post) from " + userId,
        "CLOSED Ballot: " + ballotId.toString()
      );
      return res.status(400).json({
        status: "error",
        message: "The Voting Period for this ballot has ended",
      });
    }

    console.log("Checkout for " + userId, "Ballot: " + ballotId.toString());

    // get signer address from request body
    let { signerAddress, signType } = req.body;
    // Check if signerAddress exists in the request
    if (!signerAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing signerAddress in request body",
      });
    }
    // Check if signType exists in the request
    if (!signType) {
      return res.status(400).json({
        status: "error",
        message: "Missing signType in request body",
      });
    }

    // Check if signerAddress is a valid userId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }
    // account for drep 105/129 addresses
    if (addressBech32.cip129) addressBech32 = addressBech32.cip129;
    // Check if signerAddress matches userId
    if (addressBech32 !== userId) {
      return res.status(400).json({
        status: "error",
        message: "Given address does not match userId",
      });
    }

    // converting drep PubKey to hex or whatever
    if (signerAddress.length === 64 && signType === "drep") {
      const pubkey = PublicKey.from_hex(signerAddress);
      let keyhash = pubkey.hash();
      const keyHashHex = Buffer.from(keyhash.to_bytes()).toString("hex");
      signerAddress = keyHashHex;
    }

    // check calidus key if signType = pool
    let calidusID;
    if (signType === "pool") {
      const calidusKey = await fetchCalidusKey(addressBech32);
      if (!calidusKey) {
        return res.status(400).json({
          status: "error",
          message: "Pool not found or no calidus key registered",
        });
      }
      calidusID = calidusKey.calidus_id_bech32;
    }

    // check if voter is in voter cache and validated against ballot
    const checkVoterCache = await VoterCache.findOne({
      userId,
      ballotId,
    });
    if (!checkVoterCache || checkVoterCache.validated === false) {
      console.log(
        "Voter is not allowed to vote on this ballot",
        "VoterCache: ",
        checkVoterCache
      );
      return res.status(400).json({
        status: "error",
        message: "Voter is not allowed to vote on this ballot",
      });
    }

    // create transaction object
    const transactionResponse = await createTransaction(userId, ballotId);
    // create data to sign
    transactionResponse.dataHex = stringToHex(transactionResponse.merkleRoot);
    transactionResponse.userIdHex = signerAddress;
    if (calidusID) {
      transactionResponse.calidusID = calidusID;
    }

    return res.status(200).json(transactionResponse);
  }
);

/**
 * @route PUT /api/v0/dashboard/:ballotId/checkout
 * @description Submit a signed transaction to finalize votes for a ballot. Verifies the signature, updates all votes in the transaction to submitted status, and updates the transaction status to "submitted". The signerAddress must match the authenticated userId.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - MongoDB ObjectId of the ballot
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer (must match authenticated userId, validated and converted to CIP129 if applicable)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (used for address validation)
 * @param {string} req.body.data - Merkle root of the transaction data (must match existing transaction merkleRoot)
 * @param {Object} req.body.signature - Signature object containing the signed merkle root (structure varies by signType)
 *
 * @returns {Object} 200 - Success response containing:
 *   - status: "ok"
 *   - message: "Votes submitted"
 *   - transaction: MongoDB ObjectId of the updated transaction
 * @returns {Object} 400 - Error if:
 *   - Ballot status is not "live"
 *   - signerAddress is missing
 *   - signType is missing
 *   - data (merkleRoot) is missing
 *   - Address validation fails
 *   - Signer address does not match authenticated userId
 *   - Transaction not found (no transaction with matching userId, ballotId, status="created", and merkleRoot)
 *   - Signature verification fails
 *   - Vote updates fail (no votes were modified)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.put(
  "/:ballotId/checkout",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    console.log("Submit transaction for " + req.userId);
    const userId = req.userId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "Checkout attempt (put) from " + userId,
        "CLOSED Ballot: " + ballotId.toString()
      );
      return res.status(400).json({
        status: "error",
        message: "The Voting Period for this ballot has ended",
      });
    }

    // get signer address from request body
    const { signerAddress, signType } = req.body;
    // Check if signerAddress exists in the request
    if (!signerAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing signerAddress in request body",
      });
    }
    // Check if signType exists in the request
    if (!signType) {
      return res.status(400).json({
        status: "error",
        message: "Missing signType in request body",
      });
    }

    // Check if signerAddress is a valid userId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      console.error("Address validation error", addressBech32);
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }

    // account for drep 105/129 addresses
    if (addressBech32.cip129) addressBech32 = addressBech32.cip129;

    // check if address in request body matches userId
    if (addressBech32 !== userId) {
      console.error("Address validation error", addressBech32, userId);
      return res.status(400).json({
        status: "error",
        message: "given address does not match userId",
      });
    }

    // CHECK IF TRANSACTION IS IN TRANSACTION COLLECTION
    const merkleRoot = req.body.data;
    if (!merkleRoot) {
      return res.status(400).json({
        status: "error",
        message: "Missing merkleRoot in request body",
      });
    }

    // GET TRANSACTION FROM DB
    const transaction = await Transaction.findOne({
      userId,
      ballotId,
      status: "created",
      merkleRoot,
    });
    if (!transaction) {
      return res.status(400).json({
        status: "error",
        message: "Checkout data not found",
      });
    }

    // VERIFY SIGNATURE
    const signatureVerification = await verifySignature(
      stringToHex(transaction.merkleRoot),
      userId,
      req.body.signature
    );

    if (signatureVerification.error || !signatureVerification) {
      return res.status(400).json({
        status: "error",
        message: signatureVerification.error,
      });
    }

    // UPDATE ALL VOTES
    const bulkOps = [];
    for (const voteData of transaction.votes) {
      // Create an update operation for each vote
      bulkOps.push({
        updateOne: {
          filter: {
            userId: userId,
            ballotId: ballotId,
            proposalId: voteData.proposalId,
          },
          update: {
            $set: {
              submittedAt: new Date(),
              submittedVote: voteData.vote, // Use the value from transaction
            },
          },
        },
      });
    }
    const voteUpdates = await Vote.bulkWrite(bulkOps);

    if (!voteUpdates || voteUpdates.modifiedCount === 0) {
      return res.status(400).json({
        status: "error",
        message: "Failed to update votes",
      });
    }

    // console.log(
    //   `Successfully updated ${voteUpdates.modifiedCount} votes with transaction values`
    // );

    // UPDATE THE TRANSACTION COLLECTION
    const transactionUpdate = await Transaction.findOneAndUpdate(
      { _id: transaction._id },
      {
        $set: {
          status: "submitted",
          signature: req.body.signature,
        },
      },
      { new: true }
    );

    console.log(
      "Votes submitted for " + userId,
      "Ballot: " + ballotId.toString()
    );

    // !! submit transaction / votes to hydra

    return res.status(200).json({
      status: "ok",
      message: "Votes submitted",
      transaction: transactionUpdate._id.toString(),
    });
  }
);

/**
 * @route POST /api/v0/dashboard/:ballotId/checkout/multisig
 * @route POST /api/v0/dashboard/:ballotId/checkout/multisig/:transactionId
 * @description Request checkout for a ballot using multisig, creating or retrieving transaction data. If transactionId is provided, retrieves existing pending transaction. Otherwise, creates new transaction and deletes any existing pending transaction for this voter/ballot. The scriptAddress must be a valid CIP129 multisig script address.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - MongoDB ObjectId of the ballot to checkout
 * @param {string} [req.params.transactionId] - Optional MongoDB ObjectId of an existing pending transaction to retrieve
 * @param {Object} req.body
 * @param {string} req.body.scriptAddress - CIP129 multisig script address (required, must be valid script address)
 * @param {string} req.body.signerAddress - Address of the signer (validated, converted to CIP129 if applicable)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (used for address validation)
 *
 * @returns {Object} 200 - TransactionResponse object containing:
 *   - _id: MongoDB ObjectId of the transaction
 *   - userId: ID of the voter (matches signerAddress)
 *   - ballotId: ID of the ballot
 *   - merkleRoot: Merkle root hash of all votes in transaction
 *   - votes: Object containing vote data for each proposal
 *   - dataHex: Hex-encoded merkle root (this is what the voter signs)
 *   - userIdHex: Hex-encoded signer address
 * @returns {Object} 400 - Error if:
 *   - Ballot status is not "live"
 *   - scriptAddress is missing
 *   - signerAddress is missing
 *   - signType is missing
 *   - Script address validation fails
 *   - Address is not a script address
 *   - Voter is not validated/allowed to vote on this ballot
 *   - Pending transaction not found (when transactionId is provided)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
const checkoutMultisigPost = async (req, res) => {
  const userId = req.userId;
  const ballot = req.ballot;
  const ballotId = ballot._id;
  const { transactionId } = req.params;

  // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "MS: Checkout attempt (post) from " + userId,
        "CLOSED Ballot: " + ballotId.toString()
      );
      return res.status(400).json({
        status: "error",
        message: "The Voting Period for this ballot has ended",
      });
    }

    // validate script address
    let validatedScriptAddress = await validateAddress(
      req.body.scriptAddress.trim(),
      "drep"
    );
    if (!validatedScriptAddress || validatedScriptAddress.error) {
      console.error(
        "MS: Script address validation error",
        validatedScriptAddress
      );
      return res.status(400).json({
        status: "error",
        message: validatedScriptAddress.error || "Invalid script address",
      });
    }

    // check if validatedScriptAddress is a script address
    if (!validatedScriptAddress.isScript) {
      console.error(
        "MS: Given address is not a script address",
        validatedScriptAddress
      );
      return res.status(400).json({
        status: "error",
        message: "Given address is not a script address",
      });
    }

    console.log("Checkout for " + userId, "Ballot: " + ballotId.toString());

    // get signer address from request body
    let { signerAddress, signType, scriptAddress } = req.body;
    // Check if signerAddress exists in the request
    if (!signerAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing signerAddress in request body",
      });
    }
    // Check if signType exists in the request
    if (!signType) {
      return res.status(400).json({
        status: "error",
        message: "Missing signType in request body",
      });
    }
    // Check if scriptAddress exists in the request
    if (!scriptAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing scriptAddress in request body",
      });
    }

    // Check if signerAddress is a valid userId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }
    // account for drep 105/129 addresses
    if (addressBech32.cip129) addressBech32 = addressBech32.cip129;
    // Check if signerAddress matches userId
    // !! commented out for multisig
    // if (addressBech32 !== userId) {
    //   return res.status(400).json({
    //     status: "error",
    //     message: "given address does not match userId",
    //   });
    // }

    // converting drep PubKey to hex or whatever
    if (signerAddress.length === 64 && signType === "drep") {
      const pubkey = PublicKey.from_hex(signerAddress);
      let keyhash = pubkey.hash();
      const keyHashHex = Buffer.from(keyhash.to_bytes()).toString("hex");
      signerAddress = keyHashHex;
    }

    // check if voter is in voter cache and validated against ballot
    const checkVoterCache = await VoterCache.findOne({
      userId,
      ballotId,
    });
    if (!checkVoterCache || checkVoterCache.validated === false) {
      console.log(
        "Voter is not allowed to vote on this ballot",
        "VoterCache: ",
        checkVoterCache
      );
      return res.status(400).json({
        status: "error",
        message: "Voter is not allowed to vote on this ballot",
      });
    }

    // check if pending transaction exists
    let transactionResponse;
    if (transactionId) {
      transactionResponse = await Transaction.findOne({
        _id: transactionId,
        userId,
        ballotId,
        status: "pending",
      }).lean();

      if (!transactionResponse) {
        return res.status(400).json({
          status: "error",
          message: "Pending transaction not found",
        });
      }
    } else {
      // check if pending transaction exists and delete it if it does
      const pendingTransaction = await Transaction.findOneAndDelete({
        userId,
        ballotId,
        status: "pending",
      });
      if (pendingTransaction) {
        console.log("Pending transaction found and deleted", userId, ballotId);
        // delete the transaction
        await Transaction.deleteOne({
          _id: pendingTransaction._id,
        });
      }

      // create new transaction object
      transactionResponse = await createTransaction(userId, ballotId);
    }

    // create transaction object
    // create data to sign
    transactionResponse.dataHex = stringToHex(transactionResponse.merkleRoot);
    transactionResponse.userIdHex = signerAddress;
    transactionResponse.userId = signerAddress;
    return res.status(200).json(transactionResponse);
};

router.post(
  "/:ballotId/checkout/multisig/:transactionId",
  isAuthenticated,
  getBallot,
  checkoutMultisigPost
);
router.post(
  "/:ballotId/checkout/multisig",
  isAuthenticated,
  getBallot,
  checkoutMultisigPost
);

/**
 * @route PUT /api/v0/dashboard/:ballotId/checkout/multisig
 * @description Submit a signature for a multisig transaction. Verifies that the signer is a party to the multisig script and adds the signature to the transaction's multiSig array. If all required signatures are collected, finalizes votes by updating them to submitted status and sets transaction status to "submitted". Otherwise, sets transaction status to "pending" and returns info message.
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - MongoDB ObjectId of the ballot
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer (validated, converted to CIP129 if applicable)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (used for address validation)
 * @param {string} req.body.scriptAddress - CIP129 multisig script address (required, must be valid script address)
 * @param {string} req.body.data - Merkle root of the transaction data (must match existing transaction merkleRoot)
 * @param {Object} req.body.signature - Signature object containing the signed merkle root (structure varies by signType, signedAt timestamp is added automatically)
 *
 * @returns {Object} 200 - Response object, one of:
 *   - If multisig incomplete: { status: "info", message: "MultiSig not complete yet" }
 *   - If multisig complete: { status: "ok", message: "Votes submitted", transaction: MongoDB ObjectId string }
 * @returns {Object} 400 - Error if:
 *   - Ballot status is not "live"
 *   - signerAddress is missing
 *   - signType is missing
 *   - scriptAddress is missing
 *   - data (merkleRoot) is missing
 *   - Address validation fails
 *   - Voter is not validated/allowed to vote on this ballot
 *   - Transaction not found (no transaction with matching userId, ballotId, status in ["created","pending"], and merkleRoot)
 *   - Vote updates fail (no votes were modified, when multisig is complete)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 403 - Error if signer is not a party to the multisig script (signature verification fails)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.put(
  "/:ballotId/checkout/multisig",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    console.log("Submit transaction for " + req.userId);
    const userId = req.userId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "MS: Checkout attempt (put) from " + userId,
        "CLOSED Ballot: " + ballotId.toString()
      );
      return res.status(400).json({
        status: "error",
        message: "The Voting Period for this ballot has ended",
      });
    }

    // get signer address from request body
    const { signerAddress, signType, scriptAddress } = req.body;
    // Check if signerAddress exists in the request
    if (!signerAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing signerAddress in request body",
      });
    }
    // Check if signType exists in the request
    if (!signType) {
      return res.status(400).json({
        status: "error",
        message: "Missing signType in request body",
      });
    }
    // Check if scriptAddress exists in the request
    if (!scriptAddress) {
      return res.status(400).json({
        status: "error",
        message: "Missing scriptAddress in request body",
      });
    }

    // Check if signerAddress is a valid userId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }

    // check if address in request body matches userId
    // !! commented out for multisig
    // if (addressBech32 !== userId) {
    //   return res.status(400).json({
    //     status: "error",
    //     message: "given address does not match userId",
    //   });
    // }

    // check if voter is in voter cache and validated against ballot
    const checkVoterCache = await VoterCache.findOne({
      userId,
      ballotId,
    });
    if (!checkVoterCache || checkVoterCache.validated === false) {
      console.log(
        "Voter is not allowed to vote on this ballot",
        "VoterCache: ",
        checkVoterCache
      );
      return res.status(400).json({
        status: "error",
        message: "Voter is not allowed to vote on this ballot",
      });
    }

    // !! validate merkleRoot
    const merkleRoot = req.body.data;
    if (!merkleRoot) {
      return res.status(400).json({
        status: "error",
        message: "Missing merkleRoot in request body",
      });
    }

    // GET TRANSACTION FROM DB
    const transaction = await Transaction.findOne({
      userId,
      ballotId,
      status: { $in: ["created", "pending"] },
      merkleRoot,
    });
    if (!transaction) {
      return res.status(400).json({
        status: "error",
        message: "Checkout data not found",
      });
    }

    // VERIFY SIGNATURE
    // check if party to script and verify signature
    const isParty = await isPartyToScript(
      stringToHex(transaction.merkleRoot),
      userId,
      req.body.signature
    );
    if (!isParty || isParty.error) {
      console.error(
        "isPartyToScript verification failed",
        signerAddress,
        userId,
        isParty
      );
      return res.status(403).json({
        status: "error",
        message: isParty.error,
      });
    }

    // add current signature to multisig array
    req.body.signature.signedAt = new Date();
    transaction.multiSig.push(req.body.signature);
    // check if multisig is complete
    const multisigComplete = await validateScriptSignatures(
      stringToHex(transaction.merkleRoot),
      scriptAddress,
      transaction.multiSig
    );
    if (!multisigComplete) {
      console.log(
        "Multisig not complete",
        ballotId.toString(),
        userId,
        scriptAddress
      );

      const transactionUpdate = await Transaction.findOneAndUpdate(
        { _id: transaction._id },
        {
          $set: {
            status: "pending",
            multiSig: transaction.multiSig,
          },
        },
        { new: true }
      );

      return res.status(200).json({
        status: "info",
        message: "MultiSig not complete yet",
      });
    }

    if (multisigComplete) {
      // UPDATE ALL VOTES
      const bulkOps = [];
      for (const voteData of transaction.votes) {
        // Create an update operation for each vote
        bulkOps.push({
          updateOne: {
            filter: {
              userId: userId,
              ballotId: ballotId,
              proposalId: voteData.proposalId,
            },
            update: {
              $set: {
                submittedAt: new Date(),
                submittedVote: voteData.vote, // Use the value from transaction
              },
            },
          },
        });
      }
      const voteUpdates = await Vote.bulkWrite(bulkOps);
      if (!voteUpdates || voteUpdates.modifiedCount === 0) {
        return res.status(400).json({
          status: "error",
          message: "Failed to update votes",
        });
      }

      // UPDATE THE TRANSACTION COLLECTION
      const transactionUpdate = await Transaction.findOneAndUpdate(
        { _id: transaction._id },
        {
          $set: {
            status: "submitted",
            multiSig: transaction.multiSig,
          },
        },
        { new: true }
      );

      console.log(
        "MultiSig: Votes submitted for " + userId,
        "Ballot: " + ballotId.toString()
      );

      // !! submit transaction/votes to hydra

      return res.status(200).json({
        status: "ok",
        message: "Votes submitted",
        transaction: transactionUpdate._id.toString(),
      });
    }
  }
);

export default router;
