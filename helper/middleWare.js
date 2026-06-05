// imports
import validator from "validator";

// schema imports
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { Transaction } from "../schema/Transaction.js";

// helper imports
import { verifyToken } from "../helper/verifyToken.js";
import { validateAddress, getAddressType } from "../helper/validateAddress.js";
import { resolveBallot, resolveProposal } from "../helper/idResolver.js";
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
 * 2. If valid, adds voter information (userId, signType, multiSig) to the request object
 * 3. If invalid, returns an appropriate error response
 *
 * On success, adds the following properties to the request:
 * - req.userId: The authenticated voter's ID
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
      req.userId = voterToken.userId;
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
      userId: req.userId,
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
  // The ID param can be either the canonical Mongo `_id` or the
  // upstream `proposalSource.externalBallotId` set by the proposals
  // module at import time. `resolveBallot` handles both and reports
  // ambiguity for the rare cross-module collision case.
  const ballotId = req.params.ballotId;
  if (!ballotId || typeof ballotId !== "string" || ballotId.length > 128) {
    return res.status(400).json({
      status: "error",
      message: "Ballot ID is required",
    });
  }

  try {
    const result = await resolveBallot(ballotId, {
      lean: false, // callers (e.g. /api/v0/ballots/:id) do .toObject()
      selectFields:
        "_id title description votePeriodStart votePeriodEnd voterType " +
        "voteWeighted voterValidationScript voteFilters status source " +
        "facets proposalSource votingPowerSource proposalPeriodStart " +
        "proposalPeriodEnd voteAuthorityId ipfsHash hydraEndpoint " +
        "hydraHeadId hydraHeadStatus ballotCid instancePolicyId " +
        "provisionalResultsEnabled",
    });

    if (!result) {
      return res.status(404).json({
        status: "error",
        message: "Ballot not found",
      });
    }
    if (result.ambiguous) {
      return res.status(409).json({
        status: "error",
        code: "ID_COLLISION",
        message:
          "External ballot id matches multiple ballots; use the canonical _id",
        candidates: result.ambiguous,
      });
    }

    req.ballot = result.doc;
    req.ballotId = String(result.doc._id);
    req.ballotResolvedFrom = result.source; // 'internal' | 'external'
    return next();
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal Server Error",
    });
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
  const { proposalId, ballotId } = req.params;
  // The ID param can be either the canonical Mongo `_id` or the
  // upstream `externalProposal.id` set by the proposals module at
  // import time. When the path also carries `:ballotId`, the lookup
  // is scoped to that parent — the only realistic external-id
  // collision path (same upstream id reused across ballots).
  if (
    !proposalId ||
    typeof proposalId !== "string" ||
    proposalId.length > 128
  ) {
    return res.status(400).json({
      status: "error",
      message: "Proposal ID is required",
    });
  }

  try {
    const result = await resolveProposal(proposalId, {
      ballotId, // may be undefined; resolver ignores when so
      lean: false,
    });

    if (!result) {
      return res.status(404).json({
        status: "error",
        message: "Proposal not found",
      });
    }
    if (result.ambiguous) {
      return res.status(409).json({
        status: "error",
        code: "ID_COLLISION",
        message:
          "External proposal id matches multiple proposals; use the canonical _id",
        candidates: result.ambiguous,
      });
    }

    req.proposal = result.doc.toObject();
    req.proposalId = result.doc._id;
    req.proposalResolvedFrom = result.source; // 'internal' | 'external'
    return next();
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal Server Error",
    });
  }
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

  // Multisig / script path. When the body carries a scriptAddress the
  // session identity is the script itself, and membership is settled
  // downstream by isPartyToScript — it hashes the COSE signing key and
  // checks it against the script's keyHashes. The signer's wrapper
  // credential is therefore irrelevant: we cannot dictate how a multisig
  // member's CIP-30 wallet is configured, and it may present a payment
  // (addr...), stake, or drep address. So we skip the signType/HRP gate
  // (and the payment-address block below) that the standalone path
  // enforces, and let the signing key's hash speak for itself.
  //
  // A native script has a single hash that can be wrapped as either a
  // drep_script or a stake_script credential, and both are valid multisig
  // identities (drep-group vs stake-group voter). We derive the session
  // signType from the script address's own credential kind so the voter is
  // evaluated against the matching group. Pool credentials are always
  // key-based, so only drep/stake script wrappers are accepted.
  const scriptAddress = req.body?.scriptAddress;
  if (typeof scriptAddress === "string" && scriptAddress.trim()) {
    const trimmedScript = scriptAddress.trim();
    const scriptParts = getAddressType(trimmedScript);
    if (
      scriptParts.error ||
      scriptParts.hashType !== "script" ||
      (scriptParts.type !== "drep" && scriptParts.type !== "stake")
    ) {
      return res.status(400).json({
        status: "error",
        message:
          "scriptAddress must be a drep or stake script (multisig) address.",
      });
    }
    // Stake scripts encode the network in their header byte, so a
    // wrong-network address is detectable up front with a clear message —
    // far better than letting it fail later as an opaque "not found". (A
    // drep_script carries no network byte; those surface at verify time
    // when the script can't be resolved on our network.)
    const expectedNetwork = Number.parseInt(process.env.NETWORK_ID ?? "", 10);
    if (
      scriptParts.type === "stake" &&
      Number.isInteger(expectedNetwork) &&
      Number.isInteger(scriptParts.networkId) &&
      scriptParts.networkId !== expectedNetwork
    ) {
      return res.status(400).json({
        status: "error",
        message:
          `scriptAddress is for the wrong network (address network id ` +
          `${scriptParts.networkId}, this service expects ${expectedNetwork}).`,
      });
    }
    req.isScript = true;
    req.signType = scriptParts.type;
    req.signerAddress = signerAddress.trim();
    req.addressBech32 = trimmedScript;
    return next();
  }

  // Payment-address logins are blocked on the standalone path — the
  // Hydra role space contracted to drep / pool / stake. A standalone
  // voter's identity is their stake credential, so admitting an
  // addr1... / addr_test1... would mint a second identity for the same
  // wallet. (Payment addresses ARE accepted on the multisig path above,
  // where identity is the script and the payment key only proves
  // membership.)
  if (signType === "addr" || signType === "addr_test") {
    return res.status(400).json({
      status: "error",
      message:
        "Payment addresses are not accepted. Use your stake credential (stake1... or stake_test1...) or one of: drep, pool.",
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
