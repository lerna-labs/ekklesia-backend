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

// enable dayjs duration plugin
dayjs.extend(duration);

// middleware
import { isAuthenticated } from "../../../helper/middleWare.js";
import { validateSessionRequest } from "../../../helper/middleWare.js";

// allowList
const SYSTEM_ALLOWLIST = process.env.SYSTEM_ALLOWLIST;
let allowList = [];
if (SYSTEM_ALLOWLIST == 1) {
  // load allowList json from config directory
  const allowListPath = path.join(process.cwd(), "config", "allowList.json");
  allowList = JSON.parse(fs.readFileSync(allowListPath, "utf8"));
  // check if the allowList is empty
  if (Object.keys(allowList).length === 0) {
    console.error("Allowlist is empty");
  } else {
    console.log("Allowlist enabled:", allowList.length, "entries");
  }
}

/**
 * @route GET /api/v0/session
 * @description Validate JWT token and return voter ID
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - The voter ID if token is valid
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
 * @description Request authentication nonce for standard (non-script) wallet
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by middleware)
 * @param {string} req.body.signType - Type of signature ('drep', etc.) (validated by middleware)
 *
 * @returns {Object} 200 - Nonce to sign and voter identification data
 * @returns {Object} 400 - Error if address is a script address or invalid
 * @returns {Object} 403 - Error if address is not in allowlist (when enabled)
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

  console.log("Login request", addressBech32);

  // Check if the address is in the allowlist
  if (SYSTEM_ALLOWLIST !== "0") {
    if (!allowList.includes(addressBech32)) {
      console.error("VoterId not in snapshot", addressBech32);
      return res.status(403).json({
        status: "error",
        message: "DRep-ID/Address not in snapshot",
      });
    }
  }

  // create nonce
  const nonce = generateNonce("Sign in! ");

  // Store nonce in the database
  const login = new Session({
    voterId: addressBech32,
    nonce,
  });
  await login.save();

  // return nonce and voterId
  return res.status(200).json({
    dataHex: nonce,
    voterId: addressBech32,
    voterIdHex: req.signerAddress,
    signerAddressHex: req.signerAddress,
  });
});

/**
 * @route PUT /api/v0/session
 * @description Verify signature of nonce and issue JWT token for authentication
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by middleware)
 * @param {string} req.body.signType - Type of signature ('drep', etc.) (validated by middleware)
 * @param {Object} req.body.signature - Signature object containing the signed nonce
 *
 * @returns {Object} 200 - JWT token and expiration information, also sets HTTP-only cookie
 * @returns {Object} 400 - Error if signature verification fails or nonce not found
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

  // console.log("Nonce data", nonceData.nonce);
  // console.log("signerAddress", signerAddress);
  // console.log("signature", signature);

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
      message: signatureVerification.message,
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
  console.log("Pinging Hydra for voterId:", signerAddress);
  fetch(`${process.env.HYDRA_URL}/register`, {
    method: "POST",
    headers: {
      apikey: `${process.env.HYDRA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      voterId: signerAddress
    }),
  })
    .then(response => response.json())
    .then(data => console.log("Hydra response:", data))
    .catch(error => console.error("Failed to ping Hydra:", error));

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
 * @description Logout by clearing authentication cookie
 * @access Private (requires authentication)
 *
 * @returns {Object} 200 - Success message confirming logout
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
 * @description Request authentication nonce for multisig wallet
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by middleware)
 * @param {string} req.body.signType - Type of signature ('drep', etc.) (validated by middleware)
 * @param {string} req.body.scriptAddress - The address of the multisig script
 *
 * @returns {Object} 200 - Nonce to sign and identification data including script address
 * @returns {Object} 400 - Error if script address is invalid or not a CIP129 address
 * @returns {Object} 403 - Error if address is not in allowlist (when enabled)
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
 * @description Verify signature and script membership for multisig wallet, issue JWT token
 * @access Public
 *
 * @param {Object} req.body
 * @param {string} req.body.signerAddress - The address of the signer (validated by middleware)
 * @param {string} req.body.signType - Type of signature ('drep', etc.) (validated by middleware)
 * @param {string} req.body.scriptAddress - The address of the multisig script
 * @param {Object} req.body.signature - Signature object containing the signed nonce
 *
 * @returns {Object} 200 - JWT token and expiration information, also sets HTTP-only cookie
 * @returns {Object} 400 - Error if signature verification fails, signer not party to script, or nonce not found
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
