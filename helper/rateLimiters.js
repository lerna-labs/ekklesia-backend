import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// IMPORTANT: in express-rate-limit v8 the helper signature is
// `ipKeyGenerator(ip: string, ipv6Subnet?: number)`. It returns the
// IP normalized (IPv6 collapsed to a /56 subnet by default). Pass
// `req.ip` — NOT `(req, res)`. When given the wrong shape the helper
// returns its first argument verbatim, so each request becomes a
// different `req` object → MemoryStore keys by object identity →
// every request gets a fresh bucket and the limiter never trips.
// See `.claude/issues/51.md` for the regression that taught us this.
//
// The three keyGenerator shapes below are named + exported solely so
// the security tests can lock the invariant in place without booting
// the full middleware stack.

export function ipFallbackKey(req) {
  return ipKeyGenerator(req.ip);
}
export function userOrIpKey(req) {
  return req.auth?.userId || ipKeyGenerator(req.ip);
}
export function importerOrIpKey(req) {
  return req.auth?.id || req.auth?.userId || ipKeyGenerator(req.ip);
}
export function apiKeyOrIpKey(req) {
  return req.apiKey?.id || ipKeyGenerator(req.ip);
}

/**
 * Rate limiter for nonce requests (POST /session).
 * 5 requests per minute per IP.
 */
export const nonceRequestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    status: 'error',
    message: 'Too many nonce requests. Please try again later.',
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
    status: 'error',
    message: 'Too many authentication attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Write-path limit for v1 broker endpoints (draft/signature/submit).
// Session-authenticated, so keyed by userId when available — falls back to IP.
export const voteWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: userOrIpKey,
  message: {
    status: 'error',
    message: 'Too many vote operations. Slow down.',
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
  keyGenerator: importerOrIpKey,
  message: {
    status: 'error',
    message: 'Ballot import rate limit exceeded.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-API-key bucket for the public read surface. Honors a per-key override
// stored on ApiKey.rateLimit when set; otherwise uses env defaults or
// 120 requests per minute.
export const publicApiLimiter = rateLimit({
  windowMs: Number(process.env.PUBLIC_API_WINDOW_MS) || 60 * 1000,
  max: (req) => req.apiKey?.rateLimit?.max || Number(process.env.PUBLIC_API_MAX) || 120,
  keyGenerator: apiKeyOrIpKey,
  message: {
    status: 'error',
    message: 'Public API rate limit exceeded for this key.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-IP (or per-user, when authenticated) bucket for anonymous GET
// traffic against the public read surface. Defaults to 120/min — high
// enough that a busy SPA tab is fine, low enough that one shell loop
// can't saturate the connection pool. Authenticated voters bucket by
// userId so a NAT'd corp gateway doesn't spread the limit across
// multiple users.
export const publicGetLimiter = rateLimit({
  windowMs: Number(process.env.PUBLIC_GET_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.PUBLIC_GET_MAX) || 120,
  keyGenerator: userOrIpKey,
  message: {
    status: 'error',
    message: 'Rate limit exceeded',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter bucket for endpoints that run a multi-stage Mongo aggregation
// or a regex scan — these cost more per request, so a smaller window
// keeps a single attacker IP from saturating the DB connection pool.
export const aggregationLimiter = rateLimit({
  windowMs: Number(process.env.AGGREGATION_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.AGGREGATION_MAX) || 30,
  keyGenerator: userOrIpKey,
  message: {
    status: 'error',
    message: 'Rate limit exceeded (aggregation)',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Read-side limiter for GET /api/v0/session. Per-IP because the
// session GET is the canonical "am I logged in?" probe and an attacker
// with a forged JWT could otherwise enumerate every known userId to
// learn login activity. 60/min keeps the SPA quiet and refuses bulk
// enumeration.
export const getSessionLimiter = rateLimit({
  windowMs: Number(process.env.GET_SESSION_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.GET_SESSION_MAX) || 60,
  message: {
    status: 'error',
    message: 'Too many session reads. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Authenticated per-voter bucket for the /api/v0/dashboard surface
// (own-account summary, ballots-in-progress, pending count, checkout
// flows). Keyed by userId so one voter's activity can't exhaust another
// voter's budget on a shared IP. Checkout writes under this router are
// already frozen (410) by v0Freeze in favor of /api/v1, so in practice
// this mostly bounds the read endpoints.
export const dashboardLimiter = rateLimit({
  windowMs: Number(process.env.DASHBOARD_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.DASHBOARD_MAX) || 60,
  keyGenerator: userOrIpKey,
  message: {
    status: 'error',
    message: 'Too many dashboard requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Write-side limiter for /api/v0/comments (create, like, withdraw, edit).
// Separate from the router's read bucket so comment authorship, which is
// the one user-generated-content surface on v0, gets its own, tighter
// budget instead of sharing headroom with anonymous reads.
export const commentWriteLimiter = rateLimit({
  windowMs: Number(process.env.COMMENT_WRITE_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.COMMENT_WRITE_MAX) || 20,
  keyGenerator: userOrIpKey,
  message: {
    status: 'error',
    message: 'Too many comment actions. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards the admin Hydra-ballot-lifecycle surface (/api/v1/admin/ballots,
// except /import which carries its own ballotImportLimiter). Mounted
// ahead of the `isAdmin` gate so the JWT/allowlist check itself — a
// flagged authorization sink — is covered too, not just the handlers
// after it. IP-keyed because it runs before auth resolves req.auth.
// 60/min is generous for a human operator driving prepare/start/finalize
// or polling head-info/queue-status from an admin console.
export const adminLimiter = rateLimit({
  windowMs: Number(process.env.ADMIN_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.ADMIN_MAX) || 60,
  message: {
    status: 'error',
    message: 'Too many admin requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards GET /api/v1/admin/me, the admin-status probe. Separate instance
// from adminLimiter and getSessionLimiter so this budget isn't shared
// with either the voter session probe or the heavier admin lifecycle
// surface — it does its own JWT verification (a flagged authorization
// sink) and nothing else.
export const adminAuthLimiter = rateLimit({
  windowMs: Number(process.env.ADMIN_AUTH_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.ADMIN_AUTH_MAX) || 60,
  message: {
    status: 'error',
    message: 'Too many admin status checks. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Pre-authentication guard for the /api/v1/public/* API-key surface.
// `requireApiKey` runs a database lookup on every request — including
// requests with a missing or invalid key — before `publicApiLimiter`
// (which needs `req.apiKey` to apply a per-key override) ever runs.
// This sits in front of `requireApiKey` and is IP-keyed so an
// unauthenticated flood can't drive unbounded lookups. The default is
// deliberately generous (matches PUBLIC_API_MAX's default) so it acts
// as a backstop, not the practical ceiling for a legitimate, higher-
// volume integrator whose per-key override already governs their rate.
export const apiKeyAuthLimiter = rateLimit({
  windowMs: Number(process.env.API_KEY_AUTH_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.API_KEY_AUTH_MAX) || 120,
  message: {
    status: 'error',
    message: 'Too many API key attempts. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards the dynamic OpenGraph card image routes (server.js). Each miss
// renders a PNG via Satori + resvg (real CPU cost); hits are served from
// an in-process LRU. 60/min per IP is generous for real sharing traffic
// while bounding a scripted flood of distinct cache-busting query strings.
export const ogImageLimiter = rateLimit({
  windowMs: Number(process.env.OG_IMAGE_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.OG_IMAGE_MAX) || 60,
  message: {
    status: 'error',
    message: 'Too many image requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards the SPA catch-all in server.js (`res.sendFile` of index.html for
// every non-API route). Hit on every page load and client-side
// navigation, so the default is high — generous enough that a busy tab
// set or fast in-app navigation never trips it, while still capping a
// scripted flood.
export const spaLimiter = rateLimit({
  windowMs: Number(process.env.SPA_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.SPA_MAX) || 300,
  message: {
    status: 'error',
    message: 'Too many requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards routes/health.js. That router is mounted at the server root
// (not under /api), so it was never in reach of the old app-wide
// /api limiter. Default is generous — uptime monitors and load
// balancers can legitimately poll every few seconds from more than one
// location.
export const healthLimiter = rateLimit({
  windowMs: Number(process.env.HEALTH_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.HEALTH_MAX) || 300,
  message: {
    status: 'error',
    message: 'Too many health check requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
