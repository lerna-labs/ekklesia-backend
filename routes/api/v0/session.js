// express router
import { Router } from 'express';
const router = Router();

// schema import
import { Session } from '../../../schema/Session.js';
import { User } from '../../../schema/User.js';
import { VotePackage } from '../../../schema/VotePackage.js';

// helper
import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { generateNonce } from '@meshsdk/core';
import { verifySignature, isPartyToScript } from '../../../helper/verifySignature.js';
import { validateAddress, getAddressType } from '../../../helper/validateAddress.js';
import { getScript } from '@lerna-labs/ekklesia-helpers/cardano';
import { fetchCalidusKey, fetchDrepName, fetchHandle } from '../../../helper/koios.js';
import { hydraVoterPing } from '../../../helper/hydra.js';
import {
  nonceRequestLimiter,
  sessionVerificationLimiter,
  getSessionLimiter,
} from '../../../helper/rateLimiters.js';

dayjs.extend(duration);

// middleware
import { isAuthenticated } from '../../../helper/middleWare.js';
import { validateSessionRequest } from '../../../helper/middleWare.js';

// JWT config at module load. Entropy-floor the secret so a weak or
// empty value can't ship to production unnoticed; HS256 with a short
// shared secret is brute-forceable in minutes.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured');
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters (use `openssl rand -hex 32`)');
}
const JWT_ALGORITHM = 'HS256';
let JWT_MAX_AGE = process.env.JWT_MAX_AGE || '1d';
if (!JWT_MAX_AGE.match(/^\d+[smhd]$/) && !JWT_MAX_AGE.match(/^\d+$/)) {
  console.warn(`Invalid JWT_MAX_AGE format: ${JWT_MAX_AGE}, defaulting to 1d`);
  JWT_MAX_AGE = '1d';
}

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_ERROR_MESSAGE = 'Authentication failed. Please request a new nonce and try again.';

function computeExpiryDate(expiresIn) {
  if (typeof expiresIn === 'string') {
    if (expiresIn.endsWith('d')) {
      return dayjs()
        .add(parseInt(expiresIn.slice(0, -1), 10), 'day')
        .toDate();
    }
    if (expiresIn.endsWith('h')) {
      return dayjs()
        .add(parseInt(expiresIn.slice(0, -1), 10), 'hour')
        .toDate();
    }
    if (expiresIn.endsWith('m')) {
      return dayjs()
        .add(parseInt(expiresIn.slice(0, -1), 10), 'minute')
        .toDate();
    }
    if (expiresIn.endsWith('s')) {
      return dayjs()
        .add(parseInt(expiresIn.slice(0, -1), 10), 'second')
        .toDate();
    }
    return dayjs().add(parseInt(expiresIn, 10), 'second').toDate();
  }
  return dayjs().add(1, 'hour').toDate();
}

function setAuthCookie(res, token, expiryDate) {
  res.cookie('token', token, {
    expires: expiryDate,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/',
  });
}

async function consumeNonce(userId, nonceExpiryTime) {
  const nonceData = await Session.findOneAndUpdate(
    {
      userId,
      nonce: { $ne: null },
      createdAt: { $gte: nonceExpiryTime },
    },
    { $set: { nonce: null } },
    { sort: { createdAt: -1 }, returnDocument: 'before' },
  );
  return nonceData;
}

async function clearNoncesForUser(userId) {
  await Session.updateMany({ userId, nonce: { $ne: null } }, { $set: { nonce: null } });
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  await Session.deleteMany({
    userId,
    nonce: null,
    createdAt: { $lt: thirtyMinutesAgo },
  });
}

function validateScriptAddress(scriptAddress) {
  if (!scriptAddress || typeof scriptAddress !== 'string') {
    return { error: 'MultiSig address not provided' };
  }
  const trimmed = scriptAddress.trim();
  const validated = validateAddress(trimmed, 'drep');
  if (validated.error) return { error: validated.error };
  if (!validated.isScript) return { error: 'Given address is not a script address' };
  if (!validated.cip129) return { error: 'Script address is not a CIP129 address' };
  return { validatedScriptAddress: validated.cip129 };
}

/**
 * @route GET /api/v0/session
 * @description Validate JWT and return userId plus User name/lastLogin when present.
 *   Admin status is NOT returned here — frontends gate admin UI on
 *   GET /api/v1/admin/me instead.
 * @access Private (requires authentication)
 */
router.get('/', getSessionLimiter, isAuthenticated, async (req, res) => {
  const { userId } = req;
  let name;
  let lastLogin;
  let nativeScript = null;
  try {
    const userDoc = await User.findById(userId).select('name lastLogin nativeScript').lean();
    if (userDoc) {
      if (userDoc.name != null) name = userDoc.name;
      if (userDoc.lastLogin != null) lastLogin = userDoc.lastLogin;
      if (userDoc.nativeScript) nativeScript = userDoc.nativeScript;
    }
  } catch (err) {
    console.error('Error fetching user for session GET:', err);
  }

  // Pending broker packages: anything the voter owns that still needs
  // action (draft, collecting signatures, or waiting on Hydra submit).
  // The frontend uses this to surface a "finish signing" prompt without
  // having to query each ballot individually.
  let pendingPackages = [];
  try {
    const pending = await VotePackage.find({
      userId,
      status: { $in: ['draft', 'awaiting-signatures', 'awaiting-submission'] },
    })
      .select('_id ballotId status nonce signatures nativeScript updatedAt')
      .sort({ updatedAt: -1 })
      .limit(25)
      .lean();
    pendingPackages = pending.map((p) => ({
      id: p._id.toString(),
      ballotId: p.ballotId?.toString(),
      status: p.status,
      nonce: p.nonce,
      signatureCount: Array.isArray(p.signatures) ? p.signatures.length : 0,
      isMultisig: !!p.nativeScript,
      updatedAt: p.updatedAt,
    }));
  } catch (err) {
    console.error('Error fetching pending packages for session GET:', err);
  }

  // `isAdmin` is deliberately omitted from this payload. Admin gating
  // lives on GET /api/v1/admin/me (200 for admins, 404 for everyone
  // else), so a stolen voter JWT can't be used to enumerate which
  // userIds carry admin rights.
  const payload = {
    userId,
  };
  if (name !== undefined) payload.name = name;
  if (lastLogin !== undefined) payload.lastLogin = lastLogin;
  // Always include nativeScript on the payload so the frontend can rely on
  // the field being present (null for key-based voters, JSON for script).
  payload.nativeScript = nativeScript;
  payload.pendingPackages = pendingPackages;
  return res.status(200).json(payload);
});

/**
 * @route POST /api/v0/session
 * @description Request nonce. Standard wallet: signer address as identity. Multisig: include scriptAddress in body; script address is identity.
 * @access Public
 */
router.post('/', nonceRequestLimiter, validateSessionRequest, async (req, res) => {
  const { addressBech32, isScript } = req;
  const scriptAddressBody = req.body?.scriptAddress;

  if (scriptAddressBody) {
    const scriptValidation = validateScriptAddress(scriptAddressBody);
    if (scriptValidation.error) {
      return res.status(400).json({
        status: 'error',
        message: scriptValidation.error,
      });
    }
    const { validatedScriptAddress } = scriptValidation;
    console.log('Login request (multisig)', addressBech32, validatedScriptAddress);

    const nonce = generateNonce('Sign in! ');
    try {
      const login = new Session({
        userId: validatedScriptAddress,
        nonce,
      });
      await login.save();
    } catch (error) {
      console.error('Error saving session to database:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to create authentication session. Please try again.',
      });
    }
    return res.status(200).json({
      dataHex: nonce,
      userId: validatedScriptAddress,
      userIdHex: req.signerAddress,
      signerAddressHex: req.signerAddress,
      scriptAddress: validatedScriptAddress,
    });
  }

  if (isScript) {
    return res.status(400).json({
      status: 'error',
      message: 'Script address not allowed. Please use the multisig route.',
    });
  }

  let calidusID;
  if (req.signType === 'pool') {
    const calidusKey = await fetchCalidusKey(addressBech32);
    if (!calidusKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Pool not found or no calidus key registered',
      });
    }
    calidusID = calidusKey.calidus_id_bech32;
  }

  console.log('Login request', addressBech32);
  const nonce = generateNonce('Sign in! ');
  try {
    const login = new Session({ userId: addressBech32, nonce });
    await login.save();
  } catch (error) {
    console.error('Error saving session to database:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create authentication session. Please try again.',
    });
  }
  const response = {
    dataHex: nonce,
    userId: addressBech32,
    userIdHex: req.signerAddress,
    signerAddressHex: req.signerAddress,
  };
  if (calidusID) response.calidusID = calidusID;
  return res.status(200).json(response);
});

/**
 * @route PUT /api/v0/session
 * @description Verify signature and issue JWT. Multisig: include scriptAddress in body. Upserts User lastLogin on success.
 * @access Public
 */
router.put('/', sessionVerificationLimiter, validateSessionRequest, async (req, res) => {
  const { signerAddress, signType, addressBech32, isScript } = req;
  const { signature, scriptAddress: scriptAddressBody } = req.body;
  const nonceExpiryTime = new Date(Date.now() - NONCE_TTL_MS);

  if (scriptAddressBody) {
    const scriptValidation = validateScriptAddress(scriptAddressBody);
    if (scriptValidation.error) {
      return res.status(400).json({
        status: 'error',
        message: scriptValidation.error,
      });
    }
    const { validatedScriptAddress } = scriptValidation;

    if (!signature || typeof signature !== 'object') {
      return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
    }

    let nonceData;
    try {
      nonceData = await consumeNonce(validatedScriptAddress, nonceExpiryTime);
    } catch (error) {
      console.error('Error consuming nonce:', error);
      return res.status(500).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
    }
    if (!nonceData) {
      return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
    }

    const isParty = await isPartyToScript(nonceData.nonce, validatedScriptAddress, signature);
    if (!isParty || isParty.error) {
      console.error('MS: isPartyToScript failed', signerAddress, validatedScriptAddress);
      return res.status(400).json({
        status: 'error',
        message: 'Address does not belong to the MultiSig',
      });
    }

    let token;
    try {
      token = jwt.sign(
        { userId: validatedScriptAddress, signType, multiSig: true },
        process.env.JWT_SECRET,
        { expiresIn: JWT_MAX_AGE, algorithm: JWT_ALGORITHM },
      );
    } catch (error) {
      console.error('Error creating JWT token:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to create authentication token. Please try again.',
      });
    }

    const expiryDate = computeExpiryDate(JWT_MAX_AGE);
    try {
      await clearNoncesForUser(validatedScriptAddress);
    } catch (error) {
      console.error('Error clearing nonces:', error);
    }
    try {
      await User.findOneAndUpdate(
        { _id: validatedScriptAddress },
        { $set: { lastLogin: new Date() } },
        { upsert: true },
      );
    } catch (error) {
      console.error('Error upserting User lastLogin:', error);
    }
    // Fetch + cache the native script on first multisig login (or on
    // ?refresh=true). Scripts are immutable on-chain so one fetch per
    // user is enough. Failure is non-fatal — /draft will surface a
    // clearer error if the script is actually needed later.
    try {
      const forceRefresh = req.query?.refresh === 'true';
      const existing = await User.findById(validatedScriptAddress).lean();
      if (forceRefresh || !existing?.nativeScript) {
        const addr = getAddressType(validatedScriptAddress);
        const scriptHash = addr?.keyHash;
        if (scriptHash) {
          const scriptInfo = await getScript(scriptHash);
          const nativeScript = scriptInfo?.value || scriptInfo?.script || scriptInfo || null;
          if (nativeScript) {
            await User.updateOne(
              { _id: validatedScriptAddress },
              {
                $set: {
                  nativeScript,
                  nativeScriptFetchedAt: new Date(),
                },
              },
            );
          } else {
            console.warn(
              `Multisig login: could not fetch native script for ${validatedScriptAddress} ` +
                `(hash=${scriptHash}) — Koios returned no script body`,
            );
          }
        }
      }
    } catch (error) {
      console.warn(
        `Multisig login: native-script fetch failed for ${validatedScriptAddress}: ${error.message}`,
      );
    }
    setAuthCookie(res, token, expiryDate);
    hydraVoterPing(validatedScriptAddress);
    console.log('MS: Login successful:', signerAddress, validatedScriptAddress);
    return res.status(200).json({
      token,
      expiresIn: expiryDate,
      userId: validatedScriptAddress,
    });
  }

  if (isScript) {
    return res.status(400).json({
      status: 'error',
      message: 'For script addresses include scriptAddress in the request body.',
    });
  }

  if (!signature || typeof signature !== 'object') {
    return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
  }

  let nonceData;
  try {
    nonceData = await consumeNonce(addressBech32, nonceExpiryTime);
  } catch (error) {
    console.error('Error consuming nonce:', error);
    return res.status(500).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
  }
  if (!nonceData) {
    return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
  }

  let signatureVerification;
  try {
    signatureVerification = await verifySignature(nonceData.nonce, signerAddress, signature);
  } catch (error) {
    console.error('Signature verification error', error);
    return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
  }
  if (signatureVerification?.error || !signatureVerification) {
    return res.status(400).json({ status: 'error', message: AUTH_ERROR_MESSAGE });
  }

  let token;
  try {
    token = jwt.sign({ userId: addressBech32, signType }, process.env.JWT_SECRET, {
      expiresIn: JWT_MAX_AGE,
      algorithm: JWT_ALGORITHM,
    });
  } catch (error) {
    console.error('Error creating JWT token:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create authentication token. Please try again.',
    });
  }

  const expiryDate = computeExpiryDate(JWT_MAX_AGE);
  try {
    await clearNoncesForUser(addressBech32);
  } catch (error) {
    console.error('Error clearing nonces:', error);
  }

  let userName;
  try {
    if (req.signType === 'drep') {
      userName = await fetchDrepName(addressBech32);
    } else if (req.signType === 'stake') {
      userName = await fetchHandle(addressBech32);
    }
  } catch (error) {
    console.error('Error fetching user name:', error);
  }

  try {
    const update = { lastLogin: new Date() };
    if (userName != null) update.name = userName;
    await User.findOneAndUpdate({ _id: addressBech32 }, { $set: update }, { upsert: true });
  } catch (error) {
    console.error('Error upserting User lastLogin:', error);
  }
  setAuthCookie(res, token, expiryDate);
  hydraVoterPing(addressBech32);
  console.log('Login successful:', signerAddress);
  return res.status(200).json({
    token,
    expiresIn: expiryDate,
    userId: addressBech32,
  });
});

/**
 * @route DELETE /api/v0/session
 * @description Logout by clearing the authentication cookie.
 * @access Private (requires authentication)
 */
router.delete('/', isAuthenticated, async (req, res) => {
  const { userId } = req;
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/',
  });
  console.log('Logout success', userId);
  return res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
});

export default router;
