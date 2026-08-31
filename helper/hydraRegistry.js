// Maps a ballotId → { endpoint, apiKey } for outbound calls to the Hydra
// integration service. Endpoints are stored per-ballot on the Ballot doc
// (one Hydra instance per ballot per the plan). API keys are sourced from
// env so secrets stay out of Mongo.
//
// Env:
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
// have its own variable. That variable set doubles as the allowlist of
// configured Hydra instances: every endpoint this module hands back is
// validated and canonicalized (see `allowedOrigin` below), then confirmed
// to have a matching HYDRA_API_KEY_<SLUG> before it is ever used to build
// an outbound URL. A caller-supplied endpoint (e.g. the admin /prepare
// route, which lets an admin pick the instance on first prepare) is only
// ever used if the operator has already provisioned a key for it — a
// missing or non-matching var fails fast with ENDPOINT_NOT_ALLOWED rather
// than reaching an unconfigured host.

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
 * Reduce a caller-supplied endpoint down to a validated origin
 * (`<protocol>//<host>`, no userinfo, path, query or fragment) and confirm
 * it is one of the operator's configured Hydra instances, before anything
 * derived from it is used to build an outbound URL.
 *
 * The origin is canonicalized with `new URL()` rather than passed through
 * verbatim, so the value that later reaches `hydraClient` can never carry
 * an unexpected scheme, host, port, or path — only the exact origin an
 * operator has already provisioned an API key for.
 *
 * @param {string} rawEndpoint
 * @returns {string} the canonical, allowlisted origin
 */
function allowedOrigin(rawEndpoint) {
  let parsed;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new HydraRegistryError(`Invalid Hydra endpoint: ${rawEndpoint}`, {
      code: 'INVALID_ENDPOINT',
    });
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
    throw new HydraRegistryError(`Invalid Hydra endpoint: ${rawEndpoint}`, {
      code: 'INVALID_ENDPOINT',
    });
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!resolveApiKey(origin)) {
    throw new HydraRegistryError(
      `Hydra endpoint ${origin} is not a configured instance — set ${envKeyForEndpoint(origin)} in env`,
      { code: 'ENDPOINT_NOT_ALLOWED' },
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
