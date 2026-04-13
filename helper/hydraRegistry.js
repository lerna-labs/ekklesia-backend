// Maps a ballotId → { endpoint, apiKey } for outbound calls to the Hydra
// integration service. Endpoints are stored per-ballot on the Ballot doc
// (one Hydra instance per ballot per the plan). API keys are sourced from
// env so secrets stay out of Mongo.
//
// Env:
//   HYDRA_DEFAULT_API_KEY     — used when no per-host override is set
//   HYDRA_DEFAULT_ENDPOINT    — fallback endpoint for ballots without one
//                               (admin /prepare uses this on first call)
//   HYDRA_API_KEY_<HOST>      — optional per-host override (dots replaced
//                               with underscores, upper-cased)
//                               e.g. HYDRA_API_KEY_HYDRA_PREPROD_EXAMPLE_COM

import { Ballot } from "../schema/Ballot.js";

export class HydraRegistryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "HydraRegistryError";
    this.code = code;
  }
}

function envKeyForHost(hostname) {
  return `HYDRA_API_KEY_${hostname.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
}

function resolveApiKey(endpoint) {
  if (!endpoint) return process.env.HYDRA_DEFAULT_API_KEY || null;
  try {
    const { hostname } = new URL(endpoint);
    const perHost = process.env[envKeyForHost(hostname)];
    return perHost || process.env.HYDRA_DEFAULT_API_KEY || null;
  } catch {
    return process.env.HYDRA_DEFAULT_API_KEY || null;
  }
}

/**
 * Resolve the Hydra endpoint + API key for a given ballot.
 * @param {string} ballotId
 * @returns {Promise<{ endpoint: string, apiKey: string, ballot: object }>}
 */
export async function resolveByBallotId(ballotId) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) throw new HydraRegistryError(`Ballot ${ballotId} not found`, { code: "BALLOT_NOT_FOUND" });

  const endpoint = ballot.hydraEndpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
  if (!endpoint) {
    throw new HydraRegistryError(
      `Ballot ${ballotId} has no hydraEndpoint and HYDRA_DEFAULT_ENDPOINT is not set`,
      { code: "NO_ENDPOINT" }
    );
  }
  const apiKey = resolveApiKey(endpoint);
  if (!apiKey) {
    throw new HydraRegistryError(
      `No API key resolved for ${endpoint} (set HYDRA_DEFAULT_API_KEY or per-host override)`,
      { code: "NO_API_KEY" }
    );
  }
  return { endpoint, apiKey, ballot };
}

/**
 * Resolve an explicit endpoint (used during /prepare before the ballot has
 * been associated with an instance).
 */
export function resolveByEndpoint(endpoint) {
  if (!endpoint) throw new HydraRegistryError("endpoint required", { code: "NO_ENDPOINT" });
  const apiKey = resolveApiKey(endpoint);
  if (!apiKey) {
    throw new HydraRegistryError(
      `No API key resolved for ${endpoint}`,
      { code: "NO_API_KEY" }
    );
  }
  return { endpoint, apiKey };
}
