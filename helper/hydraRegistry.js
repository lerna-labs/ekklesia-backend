// Maps a ballotId → { endpoint, apiKey } for outbound calls to the Hydra
// integration service. Endpoints are stored per-ballot on the Ballot doc
// (one Hydra instance per ballot per the plan). API keys are sourced from
// env so secrets stay out of Mongo.
//
// Env:
//   HYDRA_ALLOWED_ENDPOINTS   — comma-separated list of the Hydra instance
//                               origins this deployment may call. This is
//                               the allowlist. When unset it falls back to
//                               HYDRA_DEFAULT_ENDPOINT alone, which covers
//                               a single-instance deployment.
//   HYDRA_DEFAULT_ENDPOINT    — fallback endpoint for ballots without one
//                               stamped yet (admin /prepare uses this on
//                               first call, before the ballot has been
//                               associated with an instance).
//   HYDRA_API_KEY_<SLUG>      — required per-endpoint API key. The Hydra
//                               middleware issues a unique key per head;
//                               the slug is the full endpoint URL with
//                               every run of non-alphanumeric characters
//                               replaced by a single "_" and the result
//                               upper-cased.
//                               e.g. http://10.0.0.5:7001
//                                  → HYDRA_API_KEY_HTTP_10_0_0_5_7001
//
// There is intentionally no global default API key — every endpoint must
// have its own variable.
//
// A caller-supplied endpoint (e.g. the admin /prepare route, which lets an
// admin pick the instance on first prepare) never reaches an outbound URL.
// It is canonicalized and used to look up a match in HYDRA_ALLOWED_ENDPOINTS,
// and it is the configured entry that is handed back, not the caller's own
// string. Selecting from configuration rather than validating and re-emitting
// input means the value that was checked and the value that is used are the
// same object, so no later difference in canonicalization can open a gap
// between them. A miss fails fast with ENDPOINT_NOT_ALLOWED rather than
// reaching an unconfigured host, and an allowlisted endpoint with no
// provisioned key fails with ENDPOINT_NOT_CONFIGURED.

import { Ballot } from '../schema/Ballot.js';

export class HydraRegistryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'HydraRegistryError';
    this.code = code;
  }
}

function envKeyForEndpoint(endpoint) {
  // Collapse any run of non-alphanumerics to a single "_" so URLs with
  // multi-char separators (e.g. "://") produce friendly env-var names.
  return `HYDRA_API_KEY_${endpoint.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

function resolveApiKey(endpoint) {
  if (!endpoint) return null;
  return process.env[envKeyForEndpoint(endpoint)] || null;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reduce an endpoint to `<protocol>//<host>`, rejecting any value carrying
 * userinfo, a path, a query, a fragment, or a scheme outside http(s).
 *
 * The result is used only to compare a caller's value against the configured
 * allowlist, and to build that allowlist out of operator configuration. It is
 * never returned to a caller. A string reassembled from request input is not
 * the string that should reach an outbound URL, however carefully it was
 * checked on the way through.
 *
 * @param {string} rawEndpoint
 * @param {string} code error code to raise when the value will not canonicalize
 * @returns {string} the canonical `<protocol>//<host>`
 */
function canonicalOrigin(rawEndpoint, code) {
  let parsed;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new HydraRegistryError(`Invalid Hydra endpoint: ${rawEndpoint}`, { code });
  }

  const isRootPath = parsed.pathname === '' || parsed.pathname === '/';
  if (
    !ALLOWED_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !isRootPath ||
    parsed.search ||
    parsed.hash
  ) {
    throw new HydraRegistryError(`Invalid Hydra endpoint: ${rawEndpoint}`, { code });
  }

  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * The operator's configured Hydra instances, canonicalized.
 *
 * Read on every call rather than cached at import, so a process that reloads
 * its environment does not keep serving an allowlist the operator has already
 * changed.
 *
 * @returns {string[]} canonical origins, in configuration order
 */
function configuredOrigins() {
  const raw = process.env.HYDRA_ALLOWED_ENDPOINTS || process.env.HYDRA_DEFAULT_ENDPOINT || '';
  const origins = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = canonicalOrigin(trimmed, 'INVALID_ALLOWLIST_ENTRY');
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Resolve a caller-supplied endpoint to one of the operator's configured
 * Hydra instances.
 *
 * What comes back is the entry read out of configuration, not the caller's
 * value re-emitted after a check. The caller's value only selects which
 * configured instance was meant. Nothing derived from a request reaches the
 * outbound URL, so a canonicalization difference between the check and the
 * later use cannot open a gap between them.
 *
 * @param {string} rawEndpoint
 * @returns {string} the configured origin this endpoint selects
 */
function allowedOrigin(rawEndpoint) {
  const candidate = canonicalOrigin(rawEndpoint, 'INVALID_ENDPOINT');
  const allowed = configuredOrigins();

  const index = allowed.indexOf(candidate);
  if (index === -1) {
    throw new HydraRegistryError(
      `Hydra endpoint ${candidate} is not a configured instance. Add it to HYDRA_ALLOWED_ENDPOINTS.`,
      { code: 'ENDPOINT_NOT_ALLOWED' },
    );
  }

  const origin = allowed[index];
  if (!resolveApiKey(origin)) {
    throw new HydraRegistryError(
      `Hydra endpoint ${origin} has no API key. Set ${envKeyForEndpoint(origin)} in env.`,
      { code: 'ENDPOINT_NOT_CONFIGURED' },
    );
  }
  return origin;
}

/**
 * Resolve the Hydra endpoint + API key for a given ballot.
 * @param {string} ballotId
 * @returns {Promise<{ endpoint: string, apiKey: string, ballot: object }>}
 */
export async function resolveByBallotId(ballotId) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot)
    throw new HydraRegistryError(`Ballot ${ballotId} not found`, { code: 'BALLOT_NOT_FOUND' });

  const rawEndpoint = ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
  if (!rawEndpoint) {
    throw new HydraRegistryError(
      `Ballot ${ballotId} has no hydraEndpoint and HYDRA_DEFAULT_ENDPOINT is not set`,
      { code: 'NO_ENDPOINT' },
    );
  }
  const endpoint = allowedOrigin(rawEndpoint);
  const apiKey = resolveApiKey(endpoint);
  return { endpoint, apiKey, ballot };
}

/**
 * Resolve an explicit endpoint (used during /prepare before the ballot has
 * been associated with an instance). `endpoint` may be caller-supplied
 * (an admin picking the Hydra instance on first prepare), so it is
 * validated against the configured instance allowlist before use — see
 * `allowedOrigin`.
 */
export function resolveByEndpoint(endpoint) {
  if (!endpoint) throw new HydraRegistryError('endpoint required', { code: 'NO_ENDPOINT' });
  const origin = allowedOrigin(endpoint);
  const apiKey = resolveApiKey(origin);
  return { endpoint: origin, apiKey };
}
