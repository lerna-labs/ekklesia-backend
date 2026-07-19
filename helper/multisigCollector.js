// Native-script signature aggregation for multisig voter DReps.
//
// Uses @lerna-labs/ekklesia-helpers/crypto.getScriptCriteria to flatten
// a portable NativeScript definition into { keys, required, ... } and
// then counts collected signatures against that threshold.
//
// Notes on delegation:
//   - `validateScriptSignatures` in the shared lib expects a 4-arg
//     signature including an on-chain-encoded (timelock) script body,
//     not the portable NativeScript shape the broker sees. The broker
//     does its own signature-counting here so we don't need to round-
//     trip to Cardano-encoded form.
//   - COSE witness *validity* (signature matches COSE key → keyHash)
//     is a separate concern handled by crypto.verifySignature on each
//     incoming witness before it ever reaches this collector.

import { getScriptCriteria } from '@lerna-labs/ekklesia-helpers/crypto';

export class MultisigError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'MultisigError';
    this.code = code;
  }
}

function normalizeKey(k) {
  return (k || '').toLowerCase();
}

function keyHashesOf(signatures = []) {
  return new Set(signatures.map((s) => normalizeKey(s.key || s.keyHash)).filter(Boolean));
}

/**
 * @param {object} nativeScript  — portable NativeScript definition with a
 *                                 root of type "all" | "any" | "atLeast".
 *                                 A bare {type:"sig"} at the root is not
 *                                 multisig and shouldn't land here.
 * @param {Array<object>} signatures — collected witnesses so far.
 * @returns {{ required: number, eligibleKeys: string[], outstandingKeys: string[], satisfied: boolean }}
 */
export function status(nativeScript, signatures = []) {
  if (!nativeScript) throw new MultisigError('nativeScript required', { code: 'BAD_INPUT' });
  if (!Array.isArray(nativeScript.scripts)) {
    throw new MultisigError(
      'nativeScript must have a nested scripts array (type: all|any|atLeast)',
      { code: 'UNSUPPORTED_SCRIPT' },
    );
  }

  const criteria = getScriptCriteria(nativeScript);
  const eligibleKeys = (criteria.keys || []).map(normalizeKey);
  const required = criteria.required ?? eligibleKeys.length;

  const supplied = keyHashesOf(signatures);
  const satisfying = eligibleKeys.filter((k) => supplied.has(k));
  const outstandingKeys = eligibleKeys.filter((k) => !supplied.has(k));

  return {
    required,
    eligibleKeys,
    outstandingKeys,
    satisfied: satisfying.length >= required,
  };
}

export function thresholdMet(nativeScript, signatures) {
  return status(nativeScript, signatures).satisfied;
}

/**
 * Deduplicate collected signatures by keyHash. Later entries replace
 * earlier ones (the caller typically appends and then dedupes).
 */
export function dedupeSignatures(signatures = []) {
  const seen = new Map();
  for (const sig of signatures) {
    const key = normalizeKey(sig.key || sig.keyHash);
    if (!key) continue;
    seen.set(key, sig);
  }
  return Array.from(seen.values());
}
