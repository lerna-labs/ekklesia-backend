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
import { getCalidusKey } from "../../../helper/koios.js";

/**
 * @route GET /api/v0/dashboard
 * @description Get authenticated voter stats including last login time and pending votes count
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - Voter information including voter ID, last login timestamp, and pending votes count
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/", isAuthenticated, async (req, res) => {
  const voterId = req.voterId;

  // get last login timestamp
  const lastLogin = await Session.findOne({ voterId }).sort({
    updatedAt: -1,
  });

  // check for pending votes
  const pendingVotesCount = await getPendingVoteCount(voterId);

  return res.status(200).json({
    voterId,
    lastLogin: lastLogin ? lastLogin.updatedAt : null,
    multiSig: req.multiSig,
    pendingVotesCount,
  });
});

/**
 * @route GET /api/v0/dashboard/ballots
 * @description Get all ballots the authenticated voter can vote on or has already voted on
 * @access Private (requires authentication)
 *
 * @returns {Array} 200 - List of ballots with voter-specific information (voting power)
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/ballots", isAuthenticated, async (req, res) => {
  const voterId = req.voterId;
  // get all ballots the voter has already voted on
  const votedBallots = await Vote.find({ voterId }).distinct("ballotId");

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
    const isValidVoter = await validateVoter(voterId, ballotId);
    if (isValidVoter) {
      // get voting power for the voter
      const weight = await checkVotingPower(voterId, ballotId);
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
    "_id title description voterType status voteWeighted votePeriodStart votePeriodEnd"
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
 * @description Get all pending votes for the authenticated voter
 * @access Private (requires authentication)
 *
 * @returns {Array} 200 - List of pending votes or message if no pending votes exist
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.get("/pending", isAuthenticated, async (req, res) => {
  const voterId = req.voterId;

  const pendingVotes = await getVotes(voterId, false, "pending", true);
  if (pendingVotes.length === 0) {
    return res.status(200).json({
      message: "no pending votes",
    });
  }

  return res.status(200).json(pendingVotes);
});

/**
 * @route POST /api/v0/dashboard/:ballotId/checkout
 * @description Request checkout for a ballot, creating transaction data for signing
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - ID of the ballot to checkout
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer
 * @param {string} req.body.signType - Type of signature ('drep', etc.)
 *
 * @returns {Object} 200 - Transaction data for signing
 * @returns {Object} 400 - Error if ballot is not live, missing parameters, or invalid signer address
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.post(
  "/:ballotId/checkout/",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    const voterId = req.voterId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "Checkout attempt (post) from " + voterId,
        "CLOSED Ballot: " + ballotId.toString()
      );
      return res.status(400).json({
        status: "error",
        message: "The Voting Period for this ballot has ended",
      });
    }

    console.log("Checkout for " + voterId, "Ballot: " + ballotId.toString());

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

    // Check if signerAddress is a valid voterId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }
    // account for drep 105/129 addresses
    if (addressBech32.cip129) addressBech32 = addressBech32.cip129;
    // Check if signerAddress matches voterId
    if (addressBech32 !== voterId) {
      return res.status(400).json({
        status: "error",
        message: "Given address does not match voterId",
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
      const calidusKey = await getCalidusKey(addressBech32);
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
      voterId,
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
    const transactionResponse = await createTransaction(voterId, ballotId);
    // create data to sign
    transactionResponse.dataHex = stringToHex(transactionResponse.merkleRoot);
    transactionResponse.voterIdHex = signerAddress;
    if (calidusID) {
      transactionResponse.calidusID = calidusID;
    }

    return res.status(200).json(transactionResponse);
  }
);

/**
 * @route PUT /api/v0/dashboard/:ballotId/checkout
 * @description Submit a signed transaction to finalize votes for a ballot
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - ID of the ballot
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer
 * @param {string} req.body.signType - Type of signature ('drep', etc.)
 * @param {string} req.body.data - Merkle root of the transaction data
 * @param {Object} req.body.signature - Signature object
 *
 * @returns {Object} 200 - Confirmation of submitted votes with transaction ID
 * @returns {Object} 400 - Error if parameters invalid, signature verification fails, or votes update fails
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.put(
  "/:ballotId/checkout",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    console.log("Submit transaction for " + req.voterId);
    const voterId = req.voterId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "Checkout attempt (put) from " + voterId,
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

    // Check if signerAddress is a valid voterId
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

    // check if address in request body matches voterId
    if (addressBech32 !== voterId) {
      console.error("Address validation error", addressBech32, voterId);
      return res.status(400).json({
        status: "error",
        message: "given address does not match voterId",
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
      voterId,
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
      voterId,
      req.body.signature
    );

    if (signatureVerification.error || !signatureVerification) {
      return res.status(400).json({
        status: "error",
        message: signatureVerification.error,
      });
    }

    // !! SUBMIT THE TRANSACTION

    // UPDATE ALL VOTES
    const bulkOps = [];
    for (const voteData of transaction.votes) {
      // Create an update operation for each vote
      bulkOps.push({
        updateOne: {
          filter: {
            voterId: voterId,
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
      "Votes submitted for " + voterId,
      "Ballot: " + ballotId.toString()
    );

    return res.status(200).json({
      status: "ok",
      message: "Votes submitted",
      transaction: transactionUpdate._id.toString(),
    });
  }
);

/**
 * @route POST /api/v0/dashboard/:ballotId/checkout/multisig/:transactionId?
 * @description Request checkout for a ballot using multisig, creating or retrieving transaction data
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - ID of the ballot to checkout
 * @param {string} req.params.transactionId - Optional ID of an existing transaction
 * @param {Object} req.body
 * @param {string} req.body.scriptAddress - Address of the multisig script
 * @param {string} req.body.signerAddress - Address of the signer
 * @param {string} req.body.signType - Type of signature ('drep', etc.)
 *
 * @returns {Object} 200 - Transaction data for signing
 * @returns {Object} 400 - Error if ballot is not live, missing parameters, invalid addresses, or transaction not found
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.post(
  "/:ballotId/checkout/multisig/:transactionId?",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    const voterId = req.voterId;
    const ballot = req.ballot;
    const ballotId = ballot._id;
    const { transactionId } = req.params;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "MS: Checkout attempt (post) from " + voterId,
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

    console.log("Checkout for " + voterId, "Ballot: " + ballotId.toString());

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

    // Check if signerAddress is a valid voterId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }
    // account for drep 105/129 addresses
    if (addressBech32.cip129) addressBech32 = addressBech32.cip129;
    // Check if signerAddress matches voterId
    // !! commented out for multisig
    // if (addressBech32 !== voterId) {
    //   return res.status(400).json({
    //     status: "error",
    //     message: "given address does not match voterId",
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
      voterId,
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
        voterId,
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
        voterId,
        ballotId,
        status: "pending",
      });
      if (pendingTransaction) {
        console.log("Pending transaction found and deleted", voterId, ballotId);
        // delete the transaction
        await Transaction.deleteOne({
          _id: pendingTransaction._id,
        });
      }

      // create new transaction object
      transactionResponse = await createTransaction(voterId, ballotId);
    }

    // create transaction object
    // create data to sign
    transactionResponse.dataHex = stringToHex(transactionResponse.merkleRoot);
    transactionResponse.voterIdHex = signerAddress;
    transactionResponse.voterId = signerAddress;
    return res.status(200).json(transactionResponse);
  }
);

/**
 * @route PUT /api/v0/dashboard/:ballotId/checkout/multisig
 * @description Submit a signature for a multisig transaction, finalizing votes if all required signatures are present
 * @access Private (requires authentication)
 *
 * @param {string} req.params.ballotId - ID of the ballot
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - Address of the signer
 * @param {string} req.body.signType - Type of signature ('drep', etc.)
 * @param {string} req.body.scriptAddress - Address of the multisig script
 * @param {string} req.body.data - Merkle root of the transaction data
 * @param {Object} req.body.signature - Signature object
 *
 * @returns {Object} 200 - Confirmation of submitted signature or finalized votes with transaction ID
 * @returns {Object} 400 - Error if parameters invalid, signature verification fails, or votes update fails
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 * @returns {Object} 403 - Error if signer is not a party to the multisig script
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 */
router.put(
  "/:ballotId/checkout/multisig",
  isAuthenticated,
  getBallot,
  async (req, res) => {
    console.log("Submit transaction for " + req.voterId);
    const voterId = req.voterId;
    const ballot = req.ballot;
    const ballotId = ballot._id;

    // check if ballot is live
    if (ballot.status !== "live") {
      console.log(
        "MS: Checkout attempt (put) from " + voterId,
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

    // Check if signerAddress is a valid voterId
    let addressBech32 = validateAddress(signerAddress, signType);
    if (addressBech32.error) {
      return res.status(400).json({
        status: "error",
        message: addressBech32.error,
      });
    }

    // check if address in request body matches voterId
    // !! commented out for multisig
    // if (addressBech32 !== voterId) {
    //   return res.status(400).json({
    //     status: "error",
    //     message: "given address does not match voterId",
    //   });
    // }

    // check if voter is in voter cache and validated against ballot
    const checkVoterCache = await VoterCache.findOne({
      voterId,
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
      voterId,
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
      voterId,
      req.body.signature
    );
    if (!isParty || isParty.error) {
      console.error(
        "isPartyToScript verification failed",
        signerAddress,
        voterId,
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
        voterId,
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
              voterId: voterId,
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
            multiSig: transaction.multiSig,
          },
        },
        { new: true }
      );

      console.log(
        "MultiSig: Votes submitted for " + voterId,
        "Ballot: " + ballotId.toString()
      );

      return res.status(200).json({
        status: "ok",
        message: "Votes submitted",
        transaction: transactionUpdate._id.toString(),
      });
    }
  }
);

export default router;
