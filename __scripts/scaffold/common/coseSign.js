// Thin wrapper around the `cardano-signer` CLI (CIP-30 COSE_Sign1 signing)
// so scripts don't each have to shell out manually. Returns a CoseWitness
// in the exact shape the backend broker expects:
//
//   { coseSign1Hex, coseKeyHex, key, signature, publicKey }
//
// Requires `cardano-signer` on PATH (https://github.com/gitmachtl/cardano-signer).
//
// Output shape notes (observed from cardano-signer v1.32+ --cip30 --json-extended):
//   {
//     signature, publicKey, addressHex,
//     output: { COSE_Sign1_hex, COSE_Key_hex }
//   }
// `key` (the 28-byte keyHash the broker binds witnesses to script entries
// by) is derived client-side via blake2b_224 of publicKey — cardano-signer
// doesn't emit it directly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { normalizeWitness } from '../../../helper/coseWitness.js';

const exec = promisify(execFile);

/** Expand a leading `~` in a path. */
export function expandHome(p) {
  return p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Sign a canonical JSON string (UTF-8 bytes) with the given skey via
 * cardano-signer's CIP-30 COSE_Sign1 mode. Returns a CoseWitness the
 * backend broker will accept.
 *
 * For single-sig voters `address` is the voter's own bech32 DRep / stake /
 * pool id. For multisig voters each cosigner signs with their individual
 * skey while `address` is the SCRIPT DRep id (e.g. drep1y…) — the signature
 * binds to the script identity, not the cosigner's own identity. We always
 * pass `--nohashcheck` so cardano-signer doesn't reject that combination.
 *
 * @param {string} canonicalJson  — exact bytes the voter is signing
 * @param {string} skeyPath       — path to a Cardano `.skey` (supports `~`)
 * @param {string} address        — bech32 address for the COSE header
 */
export async function signCose(canonicalJson, skeyPath, address) {
  if (!address) throw new Error('signCose: address (bech32) is required');
  const resolved = expandHome(skeyPath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`skey not found: ${resolved}`);
  }

  const hex = Buffer.from(canonicalJson, 'utf8').toString('hex');
  const args = [
    'sign',
    '--cip30',
    '--data-hex',
    hex,
    '--secret-key',
    resolved,
    '--address',
    address,
    '--nohashcheck',
    '--json-extended',
  ];

  let stdout;
  try {
    const result = await exec('cardano-signer', args, { maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (err) {
    throw new Error(`cardano-signer failed: ${err.stderr || err.stdout || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`cardano-signer produced non-JSON output: ${stdout}`);
  }

  const coseSign1Hex = parsed.output?.COSE_Sign1_hex || parsed.COSE_Sign1_hex;
  const coseKeyHex = parsed.output?.COSE_Key_hex || parsed.COSE_Key_hex;
  if (!coseSign1Hex || !coseKeyHex) {
    throw new Error(`cardano-signer output missing fields: ${JSON.stringify(Object.keys(parsed))}`);
  }

  // Derive key/signature/publicKey centrally — same helper the backend's
  // /signature route uses, so wire-compatible output is guaranteed.
  // Pre-supply cardano-signer's own values as hints (normalizeWitness
  // preserves caller-provided fields) for a tiny CPU save.
  return normalizeWitness({
    coseSign1Hex,
    coseKeyHex,
    signature: parsed.signature,
    publicKey: parsed.publicKey,
  });
}
