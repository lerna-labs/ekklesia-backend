import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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

// Write-path limit for v1 broker endpoints (draft/signature/submit).
// Session-authenticated, so keyed by userId when available — falls back to IP.
export const voteWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req, res) => req.auth?.userId || ipKeyGenerator(req, res),
  message: {
    status: "error",
    message: "Too many vote operations. Slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Tight bucket for the compiled-ballot import endpoint. Separate from
// the public-read bucket so a noisy read workload can't starve push
// updates and vice versa. Per-key when authenticated via API key;
// per-user when authenticated via admin JWT.
export const ballotImportLimiter = rateLimit({
  windowMs: Number(process.env.BALLOT_IMPORT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.BALLOT_IMPORT_MAX) || 30,
  keyGenerator: (req, res) =>
    req.auth?.id || req.auth?.userId || ipKeyGenerator(req, res),
  message: {
    status: "error",
    message: "Ballot import rate limit exceeded.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-API-key bucket for the public read surface. Honors a per-key override
// stored on ApiKey.rateLimit when set; otherwise uses env defaults or
// 120 requests per minute.
export const publicApiLimiter = rateLimit({
  windowMs: Number(process.env.PUBLIC_API_WINDOW_MS) || 60 * 1000,
  max: (req) =>
    req.apiKey?.rateLimit?.max ||
    Number(process.env.PUBLIC_API_MAX) ||
    120,
  keyGenerator: (req, res) => req.apiKey?.id || ipKeyGenerator(req, res),
  message: {
    status: "error",
    message: "Public API rate limit exceeded for this key.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
