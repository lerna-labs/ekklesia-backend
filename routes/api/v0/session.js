// express router
import { Router } from "express";
const router = Router();

// schema import
import { Session } from "../../../schema/Session.js";

// helper
import jwt from "jsonwebtoken";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import fs from "fs";
import path from "path";
import { generateNonce } from "@meshsdk/core";
import {
  verifySignature,
  isPartyToScript,
} from "../../../helper/verifySignature.js";
import { validateAddress } from "../../../helper/validateAddress.js";
import { getCalidusKey } from "../../../helper/koios.js";
import { hydraVoterPing } from "../../../helper/hydra.js";

// enable dayjs duration plugin
dayjs.extend(duration);

// middleware
import { isAuthenticated } from "../../../helper/middleWare.js";
import { validateSessionRequest } from "../../../helper/middleWare.js";

// !! REMOVE ALLOWLIST - should be in voterValidationScript
// allowList
// const SYSTEM_ALLOWLIST = process.env.SYSTEM_ALLOWLIST;
// let allowList = [];
// if (SYSTEM_ALLOWLIST == 1) {
//   // load allowList json from config directory
//   const allowListPath = path.join(process.cwd(), "config", "allowList.json");
//   allowList = JSON.parse(fs.readFileSync(allowListPath, "utf8"));
//   // check if the allowList is empty
//   if (Object.keys(allowList).length === 0) {
//     console.error("Allowlist is empty");
//   } else {
//     console.log("Allowlist enabled:", allowList.length, "entries");
//   }
// }

/**
 * @route GET /api/v0/session
 * @description Validate JWT token and return voter ID. Used to check if user is authenticated and get their voter ID.
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - Object containing:
 *   - voterId: The voter ID from the validated JWT token
 * @returns {Object} 401 - Unauthorized if token is invalid or missing (handled by isAuthenticated middleware)
 */
router.get("/", isAuthenticated, async (req, res) => {
  const { voterId } = req;

  return res.status(200).json({
    voterId: voterId,
  });
});

/**
 * @route POST /api/v0/session
 * @description Request authentication nonce for standard (non-script) wallet. Creates a session with a random nonce that the voter must sign to prove identity. Script addresses are not allowed (use /multisig route instead).
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by validateSessionRequest middleware, must be valid Bech32 address)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (validated by middleware)
 *
 * @returns {Object} 200 - Response object containing:
 *   - dataHex: Nonce string to sign (hex-encoded)
 *   - voterId: Bech32 address of the voter
 *   - voterIdHex: Hex-encoded signer address
 *   - signerAddressHex: Hex-encoded signer address
 *   - calidusID: Calidus ID for pool signers (only present when signType is "pool")
 * @returns {Object} 400 - Error if:
 *   - Address is a script address (must use /multisig route)
 *   - Address validation fails
 *   - Pool not found or no calidus key registered (for pool signType)
 */
router.post("/", validateSessionRequest, async (req, res) => {
  // Get validated address from middleware
  const { addressBech32, isScript } = req;

  // error for script address
  if (isScript) {
    console.error("Script address not allowed");
    return res.status(400).json({
      status: "error",
      message: "Script address not allowed. Please use the multisig route.",
    });
  }

  // check for calidus key if signType = pool
  let calidusID;
  if (req.signType === "pool") {
    const calidusKey = await getCalidusKey(addressBech32);
    if (!calidusKey) {
      return res.status(400).json({
        status: "error",
        message: "Pool not found or no calidus key registered",
      });
    }
    calidusID = calidusKey.calidus_id_bech32;
  }

  console.log("Login request", addressBech32);

  // !!! can be removed, not used anymore
  // // Check if the address is in the allowlist
  // if (SYSTEM_ALLOWLIST !== "0") {
  //   if (!allowList.includes(addressBech32)) {
  //     console.error("VoterId not in snapshot", addressBech32);
  //     return res.status(403).json({
  //       status: "error",
  //       message: "DRep-ID/Address not in snapshot",
  //     });
  //   }
  // }

  // create nonce
  const nonce = generateNonce("Sign in! ");

  // Store nonce in the database
  const login = new Session({
    voterId: addressBech32,
    nonce,
  });
  await login.save();

  // return nonce and voterId
  const response = {
    dataHex: nonce,
    voterId: addressBech32,
    voterIdHex: req.signerAddress,
    signerAddressHex: req.signerAddress,
  };

  // Only include calidusID if present
  if (calidusID) {
    response.calidusID = calidusID;
  }

  return res.status(200).json(response);
});

/**
 * @route PUT /api/v0/session
 * @description Verify signature of nonce and issue JWT token for authentication. After successful verification, sets HTTP-only cookie with JWT token and clears nonce from session records. Also pings Hydra (non-blocking) to notify of voter login.
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by validateSessionRequest middleware)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (validated by middleware)
 * @param {Object} req.body.signature - Signature object containing the signed nonce (structure varies by signType)
 *
 * @returns {Object} 200 - Response object containing:
 *   - token: JWT token string (also set as HTTP-only cookie)
 *   - expiresIn: ISO 8601 timestamp when the token expires
 * @returns {Object} 400 - Error if:
 *   - Address is a script address (must use /multisig route)
 *   - Nonce not found in database
 *   - Signature verification fails
 *   - Signature verification throws an exception
 */
router.put("/", validateSessionRequest, async (req, res) => {
  // Get signer address and signature from request body (already validated by middleware)
  const { signerAddress, signType, addressBech32, isScript } = req;
  const { signature } = req.body;

  if (isScript) {
    console.error("Script address not allowed");
    return res.status(400).json({
      status: "error",
      message: "Script address not allowed. Please use the multisig route.",
    });
  }

  // get nonce from db
  const nonceData = await Session.findOne({
    voterId: addressBech32,
  }).sort({ createdAt: -1 });
  if (!nonceData) {
    return res.status(400).json({
      status: "error",
      message: "Nonce not found",
    });
  }

  // verify signature
  let signatureVerification;
  try {
    signatureVerification = await verifySignature(
      nonceData.nonce,
      signerAddress,
      signature
    );
  } catch (error) {
    console.error("Signature verification error", error);
    return res.status(400).json({
      status: "error",
      message: "Signature verification error",
    });
  }
  // console.log("Signature verification result", signatureVerification);
  if (signatureVerification.error || !signatureVerification) {
    console.error(
      "Signature verification failed",
      signerAddress,
      signatureVerification
    );
    return res.status(400).json({
      status: "error",
      message: signatureVerification.error,
    });
  }

  // create jwt token
  const token = jwt.sign(
    { voterId: addressBech32, signType },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_MAX_AGE,
    }
  );

  // !! CHECK IF STILL NEEDD
  // Calculate the actual expiration date for the frontend
  const expiresIn = process.env.JWT_MAX_AGE;
  let expiryDate;

  // Parse the expiration format (support formats like "1d", "3600s", or seconds as number)
  if (typeof expiresIn === "string") {
    if (expiresIn.endsWith("d")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "day")
        .toDate();
    } else if (expiresIn.endsWith("h")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "hour")
        .toDate();
    } else if (expiresIn.endsWith("m")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "minute")
        .toDate();
    } else if (expiresIn.endsWith("s")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "second")
        .toDate();
    } else {
      // Assume seconds if just a number
      expiryDate = dayjs().add(parseInt(expiresIn), "second").toDate();
    }
  } else {
    // Default to 1 hour if undefined or not a string
    expiryDate = dayjs().add(1, "hour").toDate();
  }

  // Delete all nonces from the database for address, but leave the login record
  await Session.updateMany(
    { voterId: signerAddress },
    {
      $set: {
        nonce: null,
      },
    }
  );

  // Log the successful login
  console.log("Login successful:", signerAddress);

  // Ping Hydra (non-blocking)
  hydraVoterPing(signerAddress);

  // Set the cookie on the response
  res.cookie("token", token, {
    expires: expiryDate,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // Only use secure in production
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax", // More permissive in development
    path: "/",
  });

  // Return the response with token data
  return res.status(200).json({
    token,
    expiresIn: expiryDate,
  });
});

/**
 * @route DELETE /api/v0/session
 * @description Logout by clearing the authentication cookie. The cookie is cleared with the same options used when it was set (httpOnly, secure, sameSite, path).
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - Success response containing:
 *   - status: "success"
 *   - message: "Logged out successfully"
 * @returns {Object} 401 - Unauthorized if not authenticated (handled by isAuthenticated middleware)
 */
router.delete("/", isAuthenticated, async (req, res) => {
  const { voterId } = req;

  // Clear the cookie with matching options from when it was set
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    path: "/",
  });

  console.log("Logout success", voterId);

  return res.status(200).json({
    status: "success",
    message: "Logged out successfully",
  });
});

/**
 * @route POST /api/v0/session/multisig
 * @description Request authentication nonce for multisig wallet. Creates a session with the CIP129 script address as voterId. The script address must be a valid CIP129 multisig script address.
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by validateSessionRequest middleware)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (validated by middleware)
 * @param {string} req.body.scriptAddress - The CIP129 multisig script address (required, must be valid script address)
 *
 * @returns {Object} 200 - Response object containing:
 *   - dataHex: Nonce string to sign (hex-encoded)
 *   - voterId: Bech32 address of the signer
 *   - voterIdHex: Hex-encoded signer address
 *   - signerAddressHex: CIP129 script address (hex-encoded)
 *   - scriptAddress: CIP129 multisig script address
 * @returns {Object} 400 - Error if:
 *   - Script address is not provided
 *   - Script address validation fails
 *   - Address is not a script address
 *   - Script address is not a CIP129 address
 * @returns {Object} 403 - Error if address is not in allowlist (when SYSTEM_ALLOWLIST is enabled)
 */
router.post("/multisig", validateSessionRequest, async (req, res) => {
  // Get validated address from middleware
  const { addressBech32 } = req;

  console.log("MS: Login request from", addressBech32, req.body.scriptAddress);

  if (!req.body.scriptAddress) {
    console.error("MS: Script address not provided");
    return res.status(400).json({
      status: "error",
      message: "MultiSig address not provided",
    });
  }

  // validate script address
  let validatedScriptAddress = await validateAddress(
    req.body.scriptAddress.trim(),
    "drep"
  );
  console.log("MS: Script address validation", validatedScriptAddress);
  if (validatedScriptAddress.error) {
    console.error(
      "MS: Script address validation error",
      validatedScriptAddress
    );
    return res.status(400).json({
      status: "error",
      message: validatedScriptAddress.error,
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

  // check if script address is cip129
  if (req.body.scriptAddress.trim() !== validatedScriptAddress.cip129) {
    console.error("MS: Script address is not a CIP129 address");
    return res.status(400).json({
      status: "error",
      message: "Script address is not a CIP129 address",
    });
  }

  // account for drep 105/129 addresses
  if (!validatedScriptAddress.cip129) {
    console.error("MS: Script address is not a CIP129 address");
    return res.status(400).json({
      status: "error",
      message: "Script address is not a CIP129 address",
    });
  }

  // use CIP129 from here on out
  validatedScriptAddress = validatedScriptAddress.cip129;

  // Check if the address is in the allowlist
  if (SYSTEM_ALLOWLIST !== "0") {
    if (!allowList.includes(addressBech32)) {
      console.error("MS: VoterId not in snapshot", addressBech32);
      return res.status(403).json({
        status: "error",
        message: "Address not in snapshot",
      });
    }
  }

  // create nonce
  const nonce = generateNonce("Sign in! ");

  // Store nonce in the database
  const login = new Session({
    voterId: validatedScriptAddress,
    nonce,
  });
  await login.save();

  // return nonce and voterId
  return res.status(200).json({
    dataHex: nonce,
    voterId: addressBech32,
    voterIdHex: req.signerAddress,
    signerAddressHex: req.body.signerAddress,
    scriptAddress: validatedScriptAddress,
  });
});

/**
 * @route PUT /api/v0/session/multisig
 * @description Verify signature and script membership for multisig wallet, then issue JWT token. Verifies that the signer is a party to the multisig script and that the signature is valid. After successful verification, sets HTTP-only cookie with JWT token and clears nonce from session records.
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by validateSessionRequest middleware)
 * @param {string} req.body.signType - Type of signature: 'drep', 'stake', or 'pool' (validated by middleware)
 * @param {string} req.body.scriptAddress - The CIP129 multisig script address (required, must be valid CIP129 script address)
 * @param {Object} req.body.signature - Signature object containing the signed nonce (structure varies by signType)
 *
 * @returns {Object} 200 - Response object containing:
 *   - token: JWT token string (also set as HTTP-only cookie, includes multiSig: true in payload)
 *   - expiresIn: ISO 8601 timestamp when the token expires
 * @returns {Object} 400 - Error if:
 *   - Script address is not provided
 *   - Script address validation fails
 *   - Address is not a script address
 *   - Script address is not a CIP129 address
 *   - Nonce not found in database
 *   - Signer is not a party to the multisig script
 *   - Signature verification fails
 */
router.put("/multisig", validateSessionRequest, async (req, res) => {
  // Get signer address and signature from request body (already validated by middleware)
  const { signerAddress, signType, addressBech32 } = req;
  const { signature } = req.body;

  console.log(
    "MS: Login request from",
    signerAddress,
    req.body.scriptAddress?.trim()
  );

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

  // account for drep 105/129 addresses
  if (!validatedScriptAddress.cip129) {
    console.error("MS: Script address is not a CIP129 address");
    return res.status(400).json({
      status: "error",
      message: "Script address is not a CIP129 address",
    });
  }

  // use CIP129 from here on out
  validatedScriptAddress = validatedScriptAddress.cip129;

  // get nonce from db
  const nonceData = await Session.findOne({
    voterId: validatedScriptAddress,
  }).sort({ createdAt: -1 });
  if (!nonceData) {
    console.error("MS: Nonce not found for address", validatedScriptAddress);
    return res.status(400).json({
      status: "error",
      message: "Nonce not found",
    });
  }

  // console.log("Nonce data", nonceData.nonce);
  // console.log("signerAddress", signerAddress);
  // console.log("scriptAddress", req.body.scriptAddress);
  // console.log("signature", signature);

  // check if party to script and verify signature
  const isParty = await isPartyToScript(
    nonceData.nonce,
    validatedScriptAddress,
    signature
  );
  if (!isParty || isParty.error) {
    console.error(
      "MS: isPartyToScript verification failed",
      signerAddress,
      validatedScriptAddress,
      isParty
    );
    return res.status(400).json({
      status: "error",
      message: "Address does not belong to the MultiSig",
    });
  }

  // create jwt token
  const token = jwt.sign(
    { voterId: validatedScriptAddress, signType, multiSig: true },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_MAX_AGE,
    }
  );

  // !! CHECK IF STILL NEEDD
  // Calculate the actual expiration date for the frontend
  const expiresIn = process.env.JWT_MAX_AGE;
  let expiryDate;

  // Parse the expiration format (support formats like "1d", "3600s", or seconds as number)
  if (typeof expiresIn === "string") {
    if (expiresIn.endsWith("d")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "day")
        .toDate();
    } else if (expiresIn.endsWith("h")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "hour")
        .toDate();
    } else if (expiresIn.endsWith("m")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "minute")
        .toDate();
    } else if (expiresIn.endsWith("s")) {
      expiryDate = dayjs()
        .add(parseInt(expiresIn.slice(0, -1)), "second")
        .toDate();
    } else {
      // Assume seconds if just a number
      expiryDate = dayjs().add(parseInt(expiresIn), "second").toDate();
    }
  } else {
    // Default to 1 hour if undefined or not a string
    expiryDate = dayjs().add(1, "hour").toDate();
  }

  // Delete all nonces from the database for address, but leave the login record
  await Session.updateMany(
    { voterId: validatedScriptAddress },
    {
      $set: {
        nonce: null,
      },
    }
  );

  // Log the successful login
  console.log("MS: Login successful:", signerAddress, validatedScriptAddress);

  // Set the cookie on the response
  res.cookie("token", token, {
    expires: expiryDate,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // Only use secure in production
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax", // More permissive in development
    path: "/",
  });

  // Return the response with token data
  return res.status(200).json({
    token,
    expiresIn: expiryDate,
  });
});

export default router;
