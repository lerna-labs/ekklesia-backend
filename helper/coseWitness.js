// Normalize a COSE_Sign1 witness produced by CIP-30 `walletApi.signData`
// (or any CIP-30/CIP-8-compatible signer — cardano-signer, Eternl, etc.)
// into the full CoseWitness shape the broker + Hydra expect:
//
//   { coseSign1Hex, coseKeyHex, key, signature, publicKey }
//
// CIP-30 and CIP-8 both return exactly two hex strings to the caller:
//
//   signature — a hex-encoded COSE_Sign1 structure (4-element CBOR array
//               [protected_headers, unprotected_headers, payload, signature])
//   key       — a hex-encoded COSE key (CBOR map with `-2` = pub key bytes)
//
// Browser clients can't practically decode this without pulling in
// cardano-serialization-lib or a dedicated CBOR + blake2b bundle, which
// would violate the frontend's no-WASM constraint. The backend already
// imports both `cbor` and `blakejs` for other flows, so we derive
// `key` (the 28-byte blake2b_224 pub-key hash used in native scripts),
// `publicKey` (raw ed25519 pub key hex), and `signature` (raw ed25519
// signature hex) here.
//
// Integrators sending full witnesses continue to work — `normalizeWitness`
// only derives fields that are missing.

import cbor from "cbor";
import blake from "blakejs";

const cborDecode = cbor.decode || cbor.default?.decode;

export class CoseWitnessError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "CoseWitnessError";
    this.code = code;
  }
}

/**
 * blake2b_224 of raw public-key bytes → 28-byte keyHash used in
 * `sig { keyHash }` entries of native scripts.
 */
export function keyHashFromPublicKeyHex(publicKeyHex) {
  if (!publicKeyHex) throw new CoseWitnessError("publicKeyHex required", { code: "BAD_INPUT" });
  const bytes = Buffer.from(publicKeyHex, "hex");
  return Buffer.from(blake.blake2b(bytes, null, 28)).toString("hex");
}

/**
 * Extract the raw ed25519 public key from a COSE key hex.
 * COSE key is a CBOR map; the `-2` entry is the uncompressed pub-key bytes.
 */
export function publicKeyFromCoseKey(coseKeyHex) {
  if (!coseKeyHex) throw new CoseWitnessError("coseKeyHex required", { code: "BAD_INPUT" });
  let map;
  try {
    map = cborDecode(Buffer.from(coseKeyHex, "hex"));
  } catch (err) {
    throw new CoseWitnessError(`coseKeyHex is not valid CBOR: ${err.message}`, {
      code: "BAD_COSE_KEY",
    });
  }
  // cbor.decode returns a Map for CBOR maps
  const pk = map instanceof Map ? map.get(-2) : map?.[-2];
  if (!pk) {
    throw new CoseWitnessError("COSE key is missing the -2 (pub-key) field", {
      code: "BAD_COSE_KEY",
    });
  }
  return Buffer.from(pk).toString("hex");
}

/**
 * Extract the raw ed25519 signature from a COSE_Sign1 hex.
 * COSE_Sign1 is a 4-element CBOR array: [protected, unprotected, payload, signature].
 */
export function signatureFromCoseSign1(coseSign1Hex) {
  if (!coseSign1Hex) throw new CoseWitnessError("coseSign1Hex required", { code: "BAD_INPUT" });
  let arr;
  try {
    arr = cborDecode(Buffer.from(coseSign1Hex, "hex"));
  } catch (err) {
    throw new CoseWitnessError(`coseSign1Hex is not valid CBOR: ${err.message}`, {
      code: "BAD_COSE_SIGN1",
    });
  }
  if (!Array.isArray(arr) || arr.length < 4) {
    throw new CoseWitnessError("COSE_Sign1 is not a 4-element array", {
      code: "BAD_COSE_SIGN1",
    });
  }
  const sig = arr[3];
  if (!sig) {
    throw new CoseWitnessError("COSE_Sign1 signature element is empty", {
      code: "BAD_COSE_SIGN1",
    });
  }
  return Buffer.from(sig).toString("hex");
}

/**
 * Fill in missing fields on a CoseWitness. Idempotent: if `key`,
 * `publicKey`, or `signature` are already present on the input, they're
 * preserved as-is (integrators may supply them pre-computed).
 *
 * @param {object} witness — at minimum { coseSign1Hex, coseKeyHex }
 * @returns {{ coseSign1Hex, coseKeyHex, key, signature, publicKey }}
 */
export function normalizeWitness(witness) {
  if (!witness) throw new CoseWitnessError("witness required", { code: "BAD_INPUT" });
  const { coseSign1Hex, coseKeyHex } = witness;
  if (!coseSign1Hex) throw new CoseWitnessError("witness.coseSign1Hex required", { code: "BAD_INPUT" });
  if (!coseKeyHex) throw new CoseWitnessError("witness.coseKeyHex required", { code: "BAD_INPUT" });

  const publicKey = witness.publicKey || publicKeyFromCoseKey(coseKeyHex);
  const signature = witness.signature || signatureFromCoseSign1(coseSign1Hex);
  const key = (witness.key || witness.keyHash || keyHashFromPublicKeyHex(publicKey)).toLowerCase();

  return {
    coseSign1Hex,
    coseKeyHex,
    key,
    signature,
    publicKey,
  };
}
