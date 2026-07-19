import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
const environment = process.env.NODE_ENV || 'development';
const envPath = `.env.${environment}`;
dotenv.config({ path: envPath });

/**
 * Verifies JWT token from request cookies
 *
 * @param {Object} req - Express request object containing cookies
 * @returns {Object} Status object with result of verification
 *
 * @description
 * This function performs the following operations:
 * 1. Retrieves the JWT secret from environment variables
 * 2. Extracts the authentication token from request cookies
 * 3. Verifies the token's signature and expiration
 * 4. Validates the token's payload structure
 *
 * Return object format on success:
 * {
 *   status: "success",
 *   message: "Token is valid",
 *   userId: <decoded voter ID>,
 *   signType: <decoded sign type>,
 *   multiSig: <boolean indicating if multisig>,
 *   exp: <token expiration timestamp>
 * }
 *
 * Return object format on failure:
 * {
 *   status: "error",
 *   message: <error description>,
 *   code: <HTTP status code>
 * }
 *
 * Error cases handled:
 * - Missing JWT secret (500)
 * - Missing token (401)
 * - Invalid token format (401)
 * - Expired token (401)
 * - Invalid signature (401)
 * - Other verification errors (401)
 */
export function verifyToken(req) {
  // Get JWT secret from environment
  const JWT_SECRET = process.env.JWT_SECRET;

  // Check if JWT_SECRET is available
  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not defined in environment variables');
    return {
      status: 'error',
      message: 'Server configuration error',
      code: 500,
    };
  }

  // Get token cookie from request
  const token = req.cookies?.token;

  // Return early if no token found
  if (!token) {
    return {
      status: 'error',
      message: 'No token provided',
      code: 401,
    };
  }

  // Verify token. Pin the algorithm explicitly — without this option
  // `jsonwebtoken` would accept whatever algorithm the token's header
  // claims, which exposes us to algorithm-confusion attacks if the
  // library's defaults ever rotate (or if an attacker forges a token
  // with `alg: "none"`).
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Make sure the token contains the required fields
    if (!decoded || !decoded.userId) {
      return {
        status: 'error',
        message: 'Invalid token format',
        code: 401,
      };
    }

    // Return success with voter ID
    return {
      status: 'success',
      message: 'Token is valid',
      userId: decoded.userId,
      signType: decoded.signType,
      multiSig: decoded.multiSig || false,
      exp: decoded.exp,
    };
  } catch (error) {
    // Handle specific JWT error types
    if (error.name === 'TokenExpiredError') {
      return {
        status: 'error',
        message: 'Token has expired',
        code: 401,
      };
    } else if (error.name === 'JsonWebTokenError') {
      return {
        status: 'error',
        message: 'Invalid token',
        code: 401,
      };
    }

    // Generic error fallback
    console.error('Token verification error:', error.message);
    return {
      status: 'error',
      message: 'Token verification failed',
      code: 401,
    };
  }
}
