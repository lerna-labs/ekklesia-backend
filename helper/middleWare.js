// imports
import validator from "validator";

// schema imports
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Transaction } from "../schema/Transaction.js";

// helper imports
import { verifyToken } from "../helper/verifyToken.js";
import { validateAddress } from "../helper/validateAddress.js";
import { PublicKey } from "@emurgo/cardano-serialization-lib-nodejs";

/**
 * Middleware to verify user authentication token
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next() if authenticated or returns error response
 *
 * @description
 * This middleware:
 * 1. Extracts and verifies the authentication token from the request
 * 2. If valid, adds voter information (voterId, signType, multiSig) to the request object
 * 3. If invalid, returns an appropriate error response
 *
 * On success, adds the following properties to the request:
 * - req.voterId: The authenticated voter's ID
 * - req.signType: The type of signature used ('drep', etc.)
 * - req.multiSig: Boolean indicating if this is a multisig authentication
 */
export function isAuthenticated(req, res, next) {
  try {
    const voterToken = verifyToken(req);
    if (voterToken.status === "error") {
      return res.status(voterToken.code).json({
        status: "error",
        message: voterToken.message,
      });
    } else {
      req.voterId = voterToken.voterId;
      req.signType = voterToken.signType;
      req.multiSig = voterToken.multiSig || false;
      return next();
    }
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal Server Error",
    });
  }
}

/**
 * Middleware to validate and retrieve a transaction by ID
 *
 * @param {Object} req - Express request object with authenticated voter ID
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next() if transaction is found or returns error response
 *
 * @description
 * This middleware:
 * 1. Extracts and validates the transaction ID from request parameters
 * 2. Verifies the transaction exists and belongs to the authenticated user
 * 3. Adds transaction data to the request object
 *
 * On success, adds the following properties to the request:
 * - req.transaction: The complete transaction document
 * - req.transactionId: The validated transaction ID
 */
export async function getTransaction(req, res, next) {
  // get transactionId from request
  const { transactionId } = req.params;
  // check if transactionId is a valid mongo id
  if (!transactionId && !validator.isMongoId(transactionId)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid Transaction ID",
    });
  }

  try {
    // find transaction in database
    const transaction = await Transaction.findOne({
      _id: transactionId,
      voterId: req.voterId,
    });
    if (!transaction) {
      return res.status(404).json({
        status: "error",
        message: "Transaction not found",
      });
    }
    req.transaction = transaction;
    req.transactionId = transactionId;

    next();
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal Server Error",
    });
  }
}

/**
 * Middleware to validate and retrieve a ballot by ID
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next() if ballot is found or returns error response
 *
 * @description
 * This middleware:
 * 1. Extracts and validates the ballot ID from request parameters
 * 2. Verifies the ballot exists in the database
 * 3. Adds ballot data to the request object
 *
 * Only necessary fields are selected from the ballot document to optimize performance.
 *
 * On success, adds the following properties to the request:
 * - req.ballot: The ballot document with selected fields
 * - req.ballotId: The validated ballot ID
 */
export async function getBallot(req, res, next) {
  // get ballotId from request
  const ballotId = req.params.ballotId;
  if (!ballotId) {
    return res.status(400).json({
      status: "error",
      message: "Ballot ID is required",
    });
  }

  if (ballotId) {
    // check if ballotId is a valid mongo id
    if (!validator.isMongoId(ballotId)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid Ballot ID",
      });
    }

    // find ballot in database
    try {
      let ballot = await Ballot.findOne({
        _id: ballotId,
      }).select(
        "_id title description votePeriodStart votePeriodEnd voterType voteWeighted voterValidationScript voteFilters status"
      );
      if (!ballot) {
        return res.status(404).json({
          status: "error",
          message: "Ballot not found",
        });
      }

      req.ballot = ballot;
      req.ballotId = ballotId;
      return next();
    } catch (error) {
      return res.status(500).json({
        status: "error",
        message: "Internal Server Error",
      });
    }
  }
}

/**
 * Middleware to validate and retrieve a proposal by ID
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next() if proposal is found or returns error response
 *
 * @description
 * This middleware:
 * 1. Extracts and validates the proposal ID from request parameters
 * 2. Verifies the proposal ID format is valid (alphanumeric and correct length)
 * 3. Retrieves the proposal from the database
 * 4. Adds proposal data to the request object
 *
 * On success, adds the following properties to the request:
 * - req.proposal: The proposal document as a plain JavaScript object
 * - req.proposalId: The validated proposal ID
 */
export async function getProposal(req, res, next) {
  const { proposalId } = req.params;
  // Check if proposalId is provided
  if (!proposalId) {
    return res.status(400).json({
      status: "error",
      message: "Proposal ID is required",
    });
  }
  // Validate the proposalId format
  if (!validator.isAlphanumeric(proposalId)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid proposal ID format",
    });
  }

  // check length of proposalId
  if (proposalId.length !== 24) {
    return res.status(400).json({
      status: "error",
      message: "Invalid proposal ID length",
    });
  }

  // get proposalData from the database
  const proposalData = await Proposal.findOne({ _id: proposalId });
  if (!proposalData) {
    return res.status(404).json({
      status: "error",
      message: "Proposal not found",
    });
  }
  // Check if the proposalId is a valid ObjectId

  // store the proposalId in the request object for later use
  req.proposal = proposalData.toObject();
  req.proposalId = proposalData._id;

  next();
}

/**
 * Middleware to validate session request parameters
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next() if parameters are valid or returns error response
 *
 * @description
 * This middleware validates:
 * 1. Signer address (presence and format)
 * 2. Sign type (presence)
 * 3. For DRep addresses, ensures CIP129 compliance
 * 4. Handles conversions for different address formats
 *
 * On success, adds the following properties to the request:
 * - req.addressBech32: The validated Bech32-encoded address
 * - req.signerAddress: The validated signer address (possibly transformed)
 * - req.signType: The validated sign type
 * - req.isScript: Boolean indicating if the address is a script address
 */
export function validateSessionRequest(req, res, next) {
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

  // Validate address format
  let addressBech32 = validateAddress(signerAddress.trim(), signType);
  // console.log("Address validation in validateSessionRequest MW", addressBech32);
  if (addressBech32.error) {
    return res.status(400).json({
      status: "error",
      message: addressBech32.error,
    });
  }

  // check if address is drep id and if not cip129, throw error
  if (
    signerAddress.startsWith("drep") &&
    addressBech32.cip129 &&
    addressBech32.cip129 != signerAddress.trim()
  ) {
    console.log("MW: Not a CIP129 Address", addressBech32);
    return res.status(400).json({
      status: "error",
      message: "Please use a CIP129 address",
    });
  }

  // account for drep 105/129 addresses
  if (addressBech32.cip129) {
    req.isScript = addressBech32.isScript;
    addressBech32 = addressBech32.cip129;
  }

  // converting drep PubKey to hex or whatever
  if (signerAddress.length === 64 && signType === "drep") {
    const pubkey = PublicKey.from_hex(signerAddress);
    let keyhash = pubkey.hash();
    const keyHashHex = Buffer.from(keyhash.to_bytes()).toString("hex");
    signerAddress = keyHashHex;
  }

  // Store validated address for use in the handler
  req.addressBech32 = addressBech32;
  req.signerAddress = signerAddress;
  req.signType = signType;
  next();
}
