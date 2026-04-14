// Typed client for the Hydra integration service
// (https://github.com/lerna-labs/hydra — see ~/ekklesia/hydra).
//
// All outbound calls to Hydra go through this module. Handles:
//   - x-api-key auth
//   - Uniform response envelope: { status, data, code, message }
//   - Retries on 5xx/network with capped exponential backoff
//   - Timeout per request
//   - Registry lookup by ballotId (or explicit endpoint during /prepare)

import { Agent } from "undici";
import {
  resolveByBallotId,
  resolveByEndpoint,
  HydraRegistryError,
} from "./hydraRegistry.js";

/**
 * Build a per-request undici Agent that won't abort before our own
 * AbortController does. Node's default `fetch` uses undici with built-in
 * headersTimeout + bodyTimeout of 300_000ms (5 min). For long-running
 * Hydra operations (waitForHeadOpen 10m, waitForHeadClose 15m, fanout
 * 10–15m) those defaults fire prematurely regardless of the AbortSignal
 * we pass. The agent below extends both to the request's timeoutMs.
 */
function longTimeoutDispatcher(timeoutMs) {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: timeoutMs,
  });
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Per-path timeouts for long-running POSTs. Defaults picked to match or
// exceed Hydra's internal wait timeouts so we don't abort client-side while
// Hydra is still working (e.g. Hydra /start uses waitForHeadOpen(600_000) —
// 10 minutes — so our client must be at least that).
const POST_TIMEOUTS_MS = {
  "/prepare": 5 * 60_000,           // L1 mint + IPFS pin
  "/prepare/cancel": 5 * 60_000,    // L1 burn
  "/prepare/update": 5 * 60_000,    // L1 re-datum
  "/prepare/handoff": 5 * 60_000,   // L1 token transfer
  "/start": 12 * 60_000,            // 10m Hydra-side + headroom
  "/finalize": 5 * 60_000,
  "/count": 5 * 60_000,
  "/settle/burn": 10 * 60_000,      // stepped — loops until remaining===0
  "/settle/finalize": 5 * 60_000,
  // Hydra's /settle/close internally waits up to 10 min on the
  // Open→FINAL path and up to 15 min on the CLOSED→FANOUT_POSSIBLE→FINAL
  // path (settlement.ts:842-850). Give the client 16 min of headroom so
  // we never abort mid-fanout.
  "/settle/close": 16 * 60_000,
  "/sweep": 5 * 60_000,
};

function defaultTimeoutFor(method, path) {
  if (method === "POST" && POST_TIMEOUTS_MS[path]) return POST_TIMEOUTS_MS[path];
  return DEFAULT_TIMEOUT_MS;
}

// Retry policy is method-aware by default. Hydra's mutating endpoints
// (/prepare, /start, /vote, etc.) are NOT idempotent — a dropped 5xx
// response followed by a client-side retry can mint the same tokens twice
// or burn wallet change a second time. We only retry reads by default.
const DEFAULT_RETRIES_BY_METHOD = {
  GET: 2,
  HEAD: 2,
  POST: 0,
  PUT: 0,
  PATCH: 0,
  DELETE: 0,
};
// A handful of POSTs are effectively read-only and safe to retry. Whitelist
// them here so we keep the rest of POST strictly one-shot.
const RETRY_SAFE_POST_PATHS = new Set(["/ledger"]);

function defaultRetriesFor(method, path) {
  if (method === "POST" && RETRY_SAFE_POST_PATHS.has(path)) return 2;
  return DEFAULT_RETRIES_BY_METHOD[method] ?? 0;
}

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
    const dispatcher = longTimeoutDispatcher(timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        dispatcher,
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
    } finally {
      dispatcher.close().catch(() => { /* ignore close errors */ });
    }
  }
  throw new HydraClientError(`Hydra ${method} ${path} exhausted retries`, { cause: lastError });
}

/**
 * Build a client bound to a specific Hydra instance. Call via `forBallot`
 * or `forEndpoint` rather than constructing directly.
 */
function buildClient({ endpoint, apiKey, timeoutMs, retries }) {
  // Explicit overrides win. Otherwise pick per method + path so L1 txs get
  // the long timeout and mutating POSTs stay one-shot.
  const resolveRetries = (method, path) =>
    retries !== undefined ? retries : defaultRetriesFor(method, path);
  const resolveTimeout = (method, path) =>
    timeoutMs !== undefined ? timeoutMs : defaultTimeoutFor(method, path);
  const call = (method, path, body) =>
    doFetch({
      endpoint,
      apiKey,
      method,
      path,
      body,
      timeoutMs: resolveTimeout(method, path),
      retries: resolveRetries(method, path),
    });

  return {
    endpoint,
    // Health / info
    health: () => call("GET", "/health"),
    headInfo: () => call("GET", "/head-info"),
    // Ballot lifecycle — L1 mint/update/cancel
    prepare: (body) => call("POST", "/prepare", body),
    prepareCancel: (body) => call("POST", "/prepare/cancel", body),
    prepareUpdate: (body) => call("POST", "/prepare/update", body),
    prepareHandoff: (body) => call("POST", "/prepare/handoff", body),

    // Head lifecycle — only /start is exposed. The top-level /close and
    // the monolithic /settle are deprecated as unreliable; the only
    // supported close path is the stepped settlement sequence below.
    start: (body) => call("POST", "/start", body),

    // Individual read-only lifecycle helpers (still useful outside the
    // settlement sequence — e.g. /finalize between rounds of partial
    // results if that's ever needed; /count for inspection). Neither
    // replaces the stepped settle path.
    finalize: () => call("POST", "/finalize"),
    count: () => call("POST", "/count"),

    // Stepped settlement — the only supported close path (Hydra spec
    // v0.3.0+). Call in order: burn → finalize → close.
    settleBurn: (body) => call("POST", "/settle/burn", body),
    settleFinalize: () => call("POST", "/settle/finalize"),
    settleClose: (body) => call("POST", "/settle/close", body),

    // Sweep / queue / cache — operations & cleanup
    sweep: (body) => call("POST", "/sweep", body),
    queueStatus: () => call("GET", "/queue/status"),
    queueDrain: (body) => call("POST", "/queue/drain", body),
    flushCache: () => call("POST", "/flush-cache"),
    // Voting — /vote is unified on Hydra: auto-registers if the voter isn't
    // yet. The legacy /vote-and-register endpoint is deprecated and no
    // longer exposed here. Use /vote for both first-time and subsequent votes.
    register: (body) => call("POST", "/register", body),
    vote: (body) => call("POST", "/vote", body),
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
