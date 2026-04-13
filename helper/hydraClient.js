// Typed client for the Hydra integration service
// (https://github.com/lerna-labs/hydra — see ~/ekklesia/hydra).
//
// All outbound calls to Hydra go through this module. Handles:
//   - x-api-key auth
//   - Uniform response envelope: { status, data, code, message }
//   - Retries on 5xx/network with capped exponential backoff
//   - Timeout per request
//   - Registry lookup by ballotId (or explicit endpoint during /prepare)

import {
  resolveByBallotId,
  resolveByEndpoint,
  HydraRegistryError,
} from "./hydraRegistry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

export class HydraClientError extends Error {
  constructor(message, { status, code, data, cause } = {}) {
    super(message);
    this.name = "HydraClientError";
    this.status = status;
    this.code = code;
    this.data = data;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function doFetch({ endpoint, apiKey, path, method = "GET", body, timeoutMs, retries }) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      let payload = null;
      try {
        payload = await res.json();
      } catch {
        // non-JSON body — surface as text
        payload = { status: "ERROR", message: await res.text().catch(() => ""), code: "NON_JSON" };
      }

      if (!res.ok) {
        // Retry 5xx once
        if (res.status >= 500 && attempt < retries) {
          attempt += 1;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new HydraClientError(
          `Hydra ${method} ${path} failed: ${res.status} ${payload?.message || ""}`.trim(),
          { status: res.status, code: payload?.code, data: payload?.data }
        );
      }

      // Envelope: { status, data, code, message }
      if (payload && payload.status === "ERROR") {
        throw new HydraClientError(payload.message || "Hydra returned ERROR status", {
          status: res.status,
          code: payload.code,
          data: payload.data,
        });
      }
      return payload?.data ?? payload;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HydraClientError) throw err;
      lastError = err;
      if (attempt < retries) {
        attempt += 1;
        await sleep(200 * 2 ** attempt);
        continue;
      }
      throw new HydraClientError(`Hydra ${method} ${path} network error: ${err.message}`, {
        cause: err,
      });
    }
  }
  throw new HydraClientError(`Hydra ${method} ${path} exhausted retries`, { cause: lastError });
}

/**
 * Build a client bound to a specific Hydra instance. Call via `forBallot`
 * or `forEndpoint` rather than constructing directly.
 */
function buildClient({ endpoint, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES }) {
  const call = (method, path, body) =>
    doFetch({ endpoint, apiKey, method, path, body, timeoutMs, retries });

  return {
    endpoint,
    // Health / info
    health: () => call("GET", "/health"),
    headInfo: () => call("GET", "/head-info"),
    // Ballot lifecycle (admin)
    prepare: (body) => call("POST", "/prepare", body),
    start: (body) => call("POST", "/start", body),
    close: (body) => call("POST", "/close", body),
    finalize: (body) => call("POST", "/finalize", body),
    count: (body) => call("POST", "/count", body),
    settle: (body) => call("POST", "/settle", body),
    // Voting
    register: (body) => call("POST", "/register", body),
    vote: (body) => call("POST", "/vote", body),
    voteAndRegister: (body) => call("POST", "/vote-and-register", body),
    // Queries
    ballot: () => call("GET", "/ballot"),
    votes: () => call("GET", "/votes"),
    voter: (voterId) => call("GET", `/voter/${encodeURIComponent(voterId)}`),
    ledger: (body) => call("POST", "/ledger", body),
    // Audit
    audit: () => call("GET", "/audit"),
    auditVote: (voterId) => call("GET", `/audit/vote/${encodeURIComponent(voterId)}`),
    auditFull: () => call("GET", "/audit/full"),
    // Low-level escape hatch for anything not modeled above
    request: call,
  };
}

export async function forBallot(ballotId, opts = {}) {
  const { endpoint, apiKey } = await resolveByBallotId(ballotId);
  return buildClient({ endpoint, apiKey, ...opts });
}

export function forEndpoint(endpoint, opts = {}) {
  const resolved = resolveByEndpoint(endpoint);
  return buildClient({ endpoint: resolved.endpoint, apiKey: resolved.apiKey, ...opts });
}

export { HydraRegistryError };
