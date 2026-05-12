// Normalized Cardano account-API layer with Koios-primary /
// Blockfrost-fallback semantics.
//
// Scope: exports the three account-level methods the stakeholder
// validator needs — accountInfo, accountAssets, accountUtxos. Each
// method tries Koios first; on a recoverable failure (network error,
// 5xx, 429) AND when a Blockfrost project_id is configured, it
// retries the normalized call against Blockfrost. 4xx responses from
// Koios (other than 429) surface as-is — those are authoritative
// (e.g. 404 = stake key not on chain).
//
// Normalized return shapes are provider-independent. Callers don't
// branch on which backend served the data; any field mapping lives
// inside the adapter.
//
// FOLLOW-UP: the existing DRep + Pool validators
// (voterValidationDReps.js, voterValidationPoolsPledge.js,
// voterValidationPoolsStake.js) still call Koios directly. Migrating
// them onto this layer is a separate PR — tracked after the first
// stake-validator preprod E2E lands.
//
// Env:
//   API_URL, API_TOKEN          — Koios (already used repo-wide)
//   BLOCKFROST_PROJECT_ID       — optional; absence disables fallback
//   BLOCKFROST_URL              — optional override. Derived from
//                                 NETWORK_NAME when unset:
//                                   "mainnet" → cardano-mainnet
//                                   anything else → cardano-preprod

const KOIOS_FETCH_TIMEOUT_MS = 10_000;
const FALLBACK_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

// --------------------------------------------------------------------
// Config + transport helpers
// --------------------------------------------------------------------

function koiosBase() {
  const v = process.env.API_URL;
  if (!v) throw new CardanoApiError("Koios API_URL not set", { code: "CONFIG" });
  return v;
}
function koiosToken() {
  return process.env.API_TOKEN || null;
}
function blockfrostBase() {
  if (process.env.BLOCKFROST_URL) return process.env.BLOCKFROST_URL;
  const net = (process.env.NETWORK_NAME || "preprod").toLowerCase();
  return net === "mainnet"
    ? "https://cardano-mainnet.blockfrost.io/api/v0"
    : "https://cardano-preprod.blockfrost.io/api/v0";
}
function blockfrostAvailable() {
  return Boolean(process.env.BLOCKFROST_PROJECT_ID);
}

export class CardanoApiError extends Error {
  constructor(message, { code, status, provider, cause } = {}) {
    super(message);
    this.name = "CardanoApiError";
    this.code = code || "UNKNOWN";
    this.status = status || null;
    this.provider = provider || null;
    if (cause) this.cause = cause;
  }
}

function isRecoverable(err) {
  // Network failures (fetch throws, no response) OR 5xx/429.
  if (err instanceof CardanoApiError) {
    if (err.status && FALLBACK_HTTP_STATUSES.has(err.status)) return true;
    return err.code === "NETWORK" || err.code === "TIMEOUT";
  }
  return true; // unexpected throw — treat as recoverable, let fallback try
}

async function timedFetch(url, init, timeoutMs = KOIOS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new CardanoApiError(`fetch timeout after ${timeoutMs}ms: ${url}`, {
        code: "TIMEOUT",
      });
    }
    throw new CardanoApiError(`fetch failed: ${err.message}`, {
      code: "NETWORK",
      cause: err,
    });
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------------------------
// Koios adapters
// --------------------------------------------------------------------

async function koiosPost(path, body) {
  const url = `${koiosBase()}${path}`;
  const headers = { "Content-Type": "application/json" };
  const tok = koiosToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await timedFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new CardanoApiError(`koios ${path} ${res.status} ${res.statusText}`, {
      code: "HTTP",
      status: res.status,
      provider: "koios",
    });
  }
  return res.json();
}

async function koiosAccountInfo(stakeAddr) {
  const rows = await koiosPost("/account_info", { _stake_addresses: [stakeAddr] });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  return {
    stakeAddress: row.stake_address,
    status: row.status,                  // "registered" | "not registered"
    delegatedPool: row.delegated_pool || null,
    totalBalance: row.total_balance || "0", // lovelace, string
    utxo: row.utxo || "0",
    rewards: row.rewards || "0",
    provider: "koios",
  };
}

async function koiosAccountAssets(stakeAddr) {
  const rows = await koiosPost("/account_assets", { _stake_addresses: [stakeAddr] });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    policyId: r.policy_id,
    assetName: r.asset_name ?? "", // Koios returns null for empty-name asset
    fingerprint: r.fingerprint || null,
    quantity: r.quantity || "0",   // string
    provider: "koios",
  }));
}

async function koiosAccountUtxos(stakeAddr) {
  const rows = await koiosPost("/account_utxos", {
    _stake_addresses: [stakeAddr],
    _extended: false,
  });
  return Array.isArray(rows) ? rows : [];
}

// --------------------------------------------------------------------
// Blockfrost adapters (fallback)
// --------------------------------------------------------------------

async function blockfrostGet(path) {
  const url = `${blockfrostBase()}${path}`;
  const res = await timedFetch(url, {
    method: "GET",
    headers: { project_id: process.env.BLOCKFROST_PROJECT_ID },
  });
  if (!res.ok) {
    throw new CardanoApiError(
      `blockfrost ${path} ${res.status} ${res.statusText}`,
      { code: "HTTP", status: res.status, provider: "blockfrost" }
    );
  }
  return res.json();
}

async function blockfrostAccountInfo(stakeAddr) {
  try {
    const row = await blockfrostGet(`/accounts/${stakeAddr}`);
    return {
      stakeAddress: stakeAddr,
      status: row.active ? "registered" : "not registered",
      delegatedPool: row.pool_id || null,
      totalBalance: row.controlled_amount || "0",
      utxo: "0", // not exposed as a distinct field
      rewards: row.rewards_sum || "0",
      provider: "blockfrost",
    };
  } catch (err) {
    if (err instanceof CardanoApiError && err.status === 404) return null;
    throw err;
  }
}

async function blockfrostAccountAssets(stakeAddr) {
  // Blockfrost paginates 100/page. Walk until fewer than 100 come back.
  const out = [];
  let page = 1;
  // Hard cap so a bug can't run us off the end of the quota.
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const rows = await blockfrostGet(
      `/accounts/${stakeAddr}/addresses/assets?page=${page}&count=100`
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const unit = r.unit || "";
      // unit = policyId (56 hex) + assetName hex (possibly empty)
      const policyId = unit.slice(0, 56);
      const assetName = unit.slice(56);
      out.push({
        policyId,
        assetName,
        fingerprint: null,
        quantity: r.quantity || "0",
        provider: "blockfrost",
      });
    }
    if (rows.length < 100) break;
    page += 1;
  }
  return out;
}

async function blockfrostAccountUtxos(stakeAddr) {
  try {
    const rows = await blockfrostGet(`/accounts/${stakeAddr}/utxos?count=100`);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err instanceof CardanoApiError && err.status === 404) return [];
    throw err;
  }
}

// --------------------------------------------------------------------
// Public methods — Koios first, Blockfrost fallback.
// --------------------------------------------------------------------

async function withFallback(label, primary, fallback) {
  try {
    return await primary();
  } catch (err) {
    const recoverable = isRecoverable(err);
    if (!recoverable || !blockfrostAvailable()) throw err;
    console.warn(
      `[cardanoApi] ${label} koios failed (${err.code}${err.status ? " " + err.status : ""}); falling back to blockfrost`
    );
    return await fallback();
  }
}

/**
 * Normalized account info. Returns null when the stake address is
 * unknown to the chain (both providers 404).
 */
export async function accountInfo(stakeAddr) {
  return withFallback(
    "accountInfo",
    () => koiosAccountInfo(stakeAddr),
    () => blockfrostAccountInfo(stakeAddr)
  );
}

/**
 * Normalized per-asset holdings for the addresses attached to a stake
 * credential. Returns `[]` when the stake address has no assets or is
 * unknown.
 */
export async function accountAssets(stakeAddr) {
  return withFallback(
    "accountAssets",
    () => koiosAccountAssets(stakeAddr),
    () => blockfrostAccountAssets(stakeAddr)
  );
}

/**
 * UTxO presence check — only the fact of non-emptiness is used by the
 * stakeholder validator; returned rows are passed through for
 * downstream code that might want more detail.
 */
export async function accountUtxos(stakeAddr) {
  return withFallback(
    "accountUtxos",
    () => koiosAccountUtxos(stakeAddr),
    () => blockfrostAccountUtxos(stakeAddr)
  );
}
