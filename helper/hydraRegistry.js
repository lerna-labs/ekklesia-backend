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
// have its own variable. A missing var fails fast with NO_API_KEY rather
// than silently authenticating against the wrong head.

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

/**
 * Resolve the Hydra endpoint + API key for a given ballot.
 * @param {string} ballotId
 * @returns {Promise<{ endpoint: string, apiKey: string, ballot: object }>}
 */
export async function resolveByBallotId(ballotId) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot)
    throw new HydraRegistryError(`Ballot ${ballotId} not found`, { code: 'BALLOT_NOT_FOUND' });

  const endpoint = ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
  if (!endpoint) {
    throw new HydraRegistryError(
      `Ballot ${ballotId} has no hydraEndpoint and HYDRA_DEFAULT_ENDPOINT is not set`,
      { code: 'NO_ENDPOINT' },
    );
  }
  const apiKey = resolveApiKey(endpoint);
  if (!apiKey) {
    throw new HydraRegistryError(
      `No API key configured for endpoint ${endpoint} — set ${envKeyForEndpoint(endpoint)} in env`,
      { code: 'NO_API_KEY' },
    );
  }
  return { endpoint, apiKey, ballot };
}

/**
 * Resolve an explicit endpoint (used during /prepare before the ballot has
 * been associated with an instance).
 */
export function resolveByEndpoint(endpoint) {
  if (!endpoint) throw new HydraRegistryError('endpoint required', { code: 'NO_ENDPOINT' });
  const apiKey = resolveApiKey(endpoint);
  if (!apiKey) {
    throw new HydraRegistryError(
      `No API key configured for endpoint ${endpoint} — set ${envKeyForEndpoint(endpoint)} in env`,
      { code: 'NO_API_KEY' },
    );
  }
  return { endpoint, apiKey };
}
