/**
 * Cardano epoch math, network-agnostic.
 *
 * Cardano epoch numbers are anchored to each network's Shelley genesis,
 * not to the Unix epoch, and the epoch length differs across networks
 * (preview = 1 day, preprod/mainnet = 5 days). This helper computes
 * "the epoch containing timestamp T" by combining live Koios `/tip`
 * (epoch_no, abs_slot, epoch_slot, block_time) with the network's
 * `/genesis` parameters (epoch_length, slot_length).
 *
 * Genesis is immutable per network so it is cached durably on disk at
 * `.cache/cardano-genesis-<host>.json` (gitignored). Tip is fetched
 * fresh every call.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const CACHE_DIR = resolve(REPO_ROOT, '.cache');

function apiBase() {
  const v = process.env.API_URL;
  if (!v) throw new Error('API_URL is not set');
  return v.replace(/\/+$/, '');
}

function apiToken() {
  const v = process.env.API_TOKEN;
  if (!v) throw new Error('API_TOKEN is not set');
  return v;
}

function cachePathForHost(host) {
  const safe = host.replace(/[^a-z0-9.-]/gi, '_');
  return resolve(CACHE_DIR, `cardano-genesis-${safe}.json`);
}

let _genesisMemo = null;

function parseGenesisRow(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('Koios /genesis: row missing or not an object');
  }
  const epochLength = Number(row.epochlength);
  const slotLength = Number(row.slotlength);
  const systemStart = Number(row.systemstart);
  const networkMagic = row.networkmagic ?? null;
  const networkId = row.networkid ?? null;
  if (!Number.isFinite(epochLength) || epochLength <= 0) {
    throw new Error(`Koios /genesis: bad epochlength=${row.epochlength}`);
  }
  if (!Number.isFinite(slotLength) || slotLength <= 0) {
    throw new Error(`Koios /genesis: bad slotlength=${row.slotlength}`);
  }
  if (!Number.isFinite(systemStart) || systemStart <= 0) {
    throw new Error(`Koios /genesis: bad systemstart=${row.systemstart}`);
  }
  return { epochLength, slotLength, systemStart, networkMagic, networkId };
}

async function fetchGenesisFromKoios() {
  const res = await fetch(`${apiBase()}/genesis`, {
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Koios /genesis failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('Koios /genesis: expected non-empty array');
  }
  return parseGenesisRow(json[0]);
}

function readDiskCache(cachePath) {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    parseGenesisRow({
      epochlength: raw.epochLength,
      slotlength: raw.slotLength,
      systemstart: raw.systemStart,
      networkmagic: raw.networkMagic,
      networkid: raw.networkId,
    });
    return raw;
  } catch {
    return null;
  }
}

function writeDiskCache(cachePath, genesis) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(genesis, null, 2));
  } catch (e) {
    console.warn(`[cardanoEpochs] could not persist genesis cache: ${e.message}`);
  }
}

/**
 * Load network genesis params: in-memory memo → disk cache → live Koios.
 * Genesis never changes for a given network, so the cache has no TTL.
 *
 * @returns {Promise<{epochLength:number, slotLength:number, systemStart:number, networkMagic:string|null, networkId:string|null}>}
 */
export async function loadGenesis() {
  if (_genesisMemo) return _genesisMemo;

  const host = new URL(apiBase()).host;
  const cachePath = cachePathForHost(host);

  const cached = readDiskCache(cachePath);
  if (cached) {
    _genesisMemo = cached;
    return cached;
  }

  const fresh = await fetchGenesisFromKoios();
  writeDiskCache(cachePath, fresh);
  _genesisMemo = fresh;
  return fresh;
}

/**
 * Live Koios `/tip` — never cached.
 *
 * @returns {Promise<{epochNo:number, epochSlot:number, absSlot:number, blockTime:number}>}
 */
export async function fetchTip() {
  const res = await fetch(`${apiBase()}/tip`, {
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Koios /tip failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('Koios /tip: expected non-empty array');
  }
  const t = json[0];
  const epochNo = Number(t.epoch_no);
  const epochSlot = Number(t.epoch_slot);
  const absSlot = Number(t.abs_slot);
  const blockTime = Number(t.block_time);
  if (
    !Number.isFinite(epochNo) ||
    !Number.isFinite(epochSlot) ||
    !Number.isFinite(absSlot) ||
    !Number.isFinite(blockTime)
  ) {
    throw new Error(`Koios /tip: malformed row ${JSON.stringify(t)}`);
  }
  return { epochNo, epochSlot, absSlot, blockTime };
}

/**
 * Compute the Cardano epoch containing `target`.
 *
 * Anchors on the current tip's epoch boundary:
 *   tipEpochStartUnix = block_time - epoch_slot * slot_length
 *   epochsAhead       = floor((targetUnix - tipEpochStartUnix) / (epoch_length * slot_length))
 *   endEpoch          = tipEpoch + epochsAhead
 *
 * Boundary semantics: if `target` lands exactly at the start of epoch
 * E+1, the result is E+1 (epoch E+1 begins at that slot). This matches
 * the Hydra (600) datum's "Cardano epoch at which voting ends" reading.
 *
 * Assumes epoch_length / slot_length are stable between tip and target
 * — Cardano hard-forks change them rarely and a ballot window of
 * weeks-to-months won't span one in practice. If a fork is anticipated
 * mid-window, recompute manually.
 *
 * @param {Date|string|number} target — Date, ISO-8601 string, or unix seconds
 * @returns {Promise<number>}
 */
export async function epochForDate(target) {
  let targetUnix;
  if (target instanceof Date) {
    targetUnix = Math.floor(target.getTime() / 1000);
  } else if (typeof target === 'string') {
    targetUnix = Math.floor(new Date(target).getTime() / 1000);
  } else {
    targetUnix = Number(target);
  }
  if (!Number.isFinite(targetUnix)) {
    throw new Error(`epochForDate: invalid target ${target}`);
  }

  const { epochLength, slotLength } = await loadGenesis();
  const tip = await fetchTip();

  const tipEpochStartUnix = tip.blockTime - tip.epochSlot * slotLength;
  const epochDurationSec = epochLength * slotLength;
  const epochsAhead = Math.floor((targetUnix - tipEpochStartUnix) / epochDurationSec);
  return tip.epochNo + epochsAhead;
}

/** Test-only: clear the in-memory genesis memo. */
export function _resetGenesisMemo() {
  _genesisMemo = null;
}
