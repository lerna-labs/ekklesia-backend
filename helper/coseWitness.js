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
import { PublicKey, Ed25519Signature } from "@emurgo/cardano-serialization-lib-nodejs";

const cborDecode = cbor.decode || cbor.default?.decode;
const cborEncode = cbor.encode || cbor.default?.encode;

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
 * Decode a COSE_Sign1 hex into its four CBOR elements:
 *   [ protected (bstr), unprotected (map), payload (bstr), signature (bstr) ]
 * `protected` and `signature` and `payload` come back as Buffers; the
 * unprotected header is normalized to a Map (the cbor lib returns either a
 * Map or a plain object depending on the key types).
 */
export function decodeCoseSign1(coseSign1Hex) {
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
  let unprotected = arr[1];
  if (!(unprotected instanceof Map) && unprotected && typeof unprotected === "object") {
    unprotected = new Map(Object.entries(unprotected));
  }
  if (!(unprotected instanceof Map)) unprotected = new Map();
  return {
    protectedHeader: arr[0] != null ? Buffer.from(arr[0]) : Buffer.alloc(0),
    unprotected,
    payload: arr[2] != null ? Buffer.from(arr[2]) : Buffer.alloc(0),
    signature: arr[3],
  };
}

/**
 * Extract the raw ed25519 signature from a COSE_Sign1 hex.
 */
export function signatureFromCoseSign1(coseSign1Hex) {
  const { signature } = decodeCoseSign1(coseSign1Hex);
  if (!signature) {
    throw new CoseWitnessError("COSE_Sign1 signature element is empty", {
      code: "BAD_COSE_SIGN1",
    });
  }
  return Buffer.from(signature).toString("hex");
}

/**
 * Extract the signed payload (element 3) from a COSE_Sign1 hex as a Buffer.
 * For an Ekklesia vote this is the UTF-8 bytes of the 64-char merkleRoot hex
 * string the voter signs (CIP-8 `hashed:false`), or its blake2b_224 digest
 * when a wallet signs with the `hashed:true` header.
 */
export function payloadFromCoseSign1(coseSign1Hex) {
  return decodeCoseSign1(coseSign1Hex).payload;
}

/**
 * Reconstruct the COSE Sig_structure that an Ed25519 key actually signs and
 * verify the witness's signature over it. Mirrors the CIP-8/CIP-30
 * construction used by @lerna-labs/ekklesia-helpers `verifySignature`:
 *
 *   Sig_structure = [ "Signature1", protected_header_bytes, external_aad(""), payload ]
 *
 * @param {{coseSign1Hex:string, coseKeyHex?:string, publicKey?:string}} witness
 * @returns {boolean} true iff the signature is a valid Ed25519 signature over
 *   the COSE_Sign1's own payload by the witness's public key.
 */
export function coseSignatureValid(witness) {
  if (!witness?.coseSign1Hex) {
    throw new CoseWitnessError("witness.coseSign1Hex required", { code: "BAD_INPUT" });
  }
  const publicKeyHex =
    witness.publicKey || (witness.coseKeyHex ? publicKeyFromCoseKey(witness.coseKeyHex) : null);
  if (!publicKeyHex) {
    throw new CoseWitnessError("witness.publicKey or coseKeyHex required", { code: "BAD_INPUT" });
  }
  const { protectedHeader, payload, signature } = decodeCoseSign1(witness.coseSign1Hex);
  if (!signature) {
    throw new CoseWitnessError("COSE_Sign1 signature element is empty", { code: "BAD_COSE_SIGN1" });
  }
  const sigStructure = ["Signature1", protectedHeader, Buffer.alloc(0), payload];
  const signedBytes = cborEncode(sigStructure);
  let pub;
  let sig;
  try {
    pub = PublicKey.from_hex(publicKeyHex);
    sig = Ed25519Signature.from_hex(Buffer.from(signature).toString("hex"));
  } catch (err) {
    throw new CoseWitnessError(`invalid COSE key/signature encoding: ${err.message}`, {
      code: "BAD_COSE_SIGN1",
    });
  }
  return pub.verify(Uint8Array.from(signedBytes), sig);
}

/**
 * Full witness verification against a known merkleRoot: confirm the witness
 * signed THIS vote's merkleRoot and nothing else.
 *
 * Two independent checks, both required (this is the gap the audit flagged —
 * the middleware counted witnesses on key membership alone, and the broker
 * historically served the *evidence voteHash* as the signing target, so
 * cosigners signed the wrong message):
 *
 *   1. message_matches — the COSE_Sign1 payload equals the bytes the voter is
 *      supposed to sign: the UTF-8 bytes of the `merkleRoot` hex string
 *      (or, for a `hashed:true` witness, their blake2b_224 digest).
 *   2. validates       — the Ed25519 signature is cryptographically valid over
 *      the COSE Sig_structure.
 *
 * @param {object} witness      normalized witness ({ coseSign1Hex, coseKeyHex, publicKey, ... })
 * @param {string} merkleRootHex the 64-char hex string the voter signs
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifyWitnessAgainstMerkleRoot(witness, merkleRootHex) {
  if (!merkleRootHex || typeof merkleRootHex !== "string") {
    throw new CoseWitnessError("merkleRootHex required", { code: "BAD_INPUT" });
  }
  const decoded = decodeCoseSign1(witness.coseSign1Hex);
  const expected = Buffer.from(merkleRootHex, "utf8");
  const hashed = decoded.unprotected.get("hashed") === true;
  const expectedSigned = hashed
    ? Buffer.from(blake.blake2b(expected, null, 28))
    : expected;
  if (!decoded.payload.equals(expectedSigned)) {
    return {
      ok: false,
      reason: "SIGNATURE_MESSAGE_MISMATCH: COSE payload is not this vote's merkleRoot",
    };
  }
  if (!coseSignatureValid(witness)) {
    return { ok: false, reason: "SIGNATURE_INVALID: Ed25519 signature does not verify" };
  }
  return { ok: true, reason: null };
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
