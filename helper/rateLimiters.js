import rateLimit from "express-rate-limit";

/**
 * Rate limiter for nonce requests (POST /session).
 * 5 requests per minute per IP.
 */
export const nonceRequestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    status: "error",
    message: "Too many nonce requests. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for session verification (PUT /session).
 * 10 requests per minute per IP.
 */
export const sessionVerificationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: {
    status: "error",
    message: "Too many authentication attempts. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
