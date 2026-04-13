// Native-script signature aggregation for voter DReps using multi-sig.
//
// Given a NativeScript definition and a running list of collected signatures
// (each is an object with `key` = signer keyHash hex, `coseSign1Hex`, etc.),
// determines whether the script is satisfied.
//
// Delegates the actual threshold logic to @lerna-labs/ekklesia-helpers/crypto:
//   - getScriptCriteria(script)   → { required, keys: [keyHash...] }
//   - validateScriptSignatures(script, signatures) → boolean / detail
//
// The wrapper here adds:
//   - a list of still-required keyHashes
//   - a dedupe + structural check of incoming witnesses
//   - a `thresholdMet(script, signatures)` helper that's easy to call from
//     the route without needing to know helper-package internals.

import {
  getScriptCriteria,
  validateScriptSignatures,
} from "@lerna-labs/ekklesia-helpers/crypto";

export class MultisigError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "MultisigError";
    this.code = code;
  }
}

function keyHashesOf(signatures = []) {
  return new Set(signatures.map((s) => (s.key || s.keyHash || "").toLowerCase()).filter(Boolean));
}

/**
 * @param {object} nativeScript  — portable native-script definition
 * @param {Array<object>} signatures — collected witnesses so far
 * @returns {{ required: number, satisfied: boolean, outstandingKeys: string[] }}
 */
export function status(nativeScript, signatures = []) {
  if (!nativeScript) throw new MultisigError("nativeScript required", { code: "BAD_INPUT" });
  const criteria = getScriptCriteria(nativeScript);
  const supplied = keyHashesOf(signatures);

  const validHashes = (criteria.keys || []).map((k) => k.toLowerCase());
  const outstandingKeys = validHashes.filter((k) => !supplied.has(k));

  const satisfied = validateScriptSignatures(nativeScript, signatures);

  return {
    required: criteria.required ?? validHashes.length,
    eligibleKeys: validHashes,
    outstandingKeys,
    satisfied: Boolean(satisfied),
  };
}

export function thresholdMet(nativeScript, signatures) {
  return status(nativeScript, signatures).satisfied;
}

/**
 * Return signatures with any duplicates (by key hash) removed. Later entries
 * win; callers typically append to an array and then call this.
 */
export function dedupeSignatures(signatures = []) {
  const seen = new Map();
  for (const sig of signatures) {
    const key = (sig.key || sig.keyHash || "").toLowerCase();
    if (!key) continue;
    seen.set(key, sig);
  }
  return Array.from(seen.values());
}
