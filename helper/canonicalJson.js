// Canonical JSON (RFC 8785 / JCS): recursively sorted object keys, arrays in
// order, no insignificant whitespace. This is the byte-level target for signing
// and hashing (vote `voteHash`, proposal `contentHash`, certified-result
// payloads) so the backend, the Hydra middleware, and external replay auditors
// all hash identical bytes from the same logical object.
//
// The implementation now lives in the shared `@lerna-labs/ekklesia-helpers/json`
// package — the single canonical source Hydra also imports (audit finding
// F-006). This module is a thin re-export so existing consumers keep their
// `./canonicalJson.js` import path unchanged (the documented helper-migration
// pattern). The only local wrinkle: `canonicalBytes` returns a Node `Buffer`
// rather than the shared impl's `Uint8Array`, because callers feed the result
// to blake2b / `res.send` / `.length` and a few rely on Buffer semantics.

import {
  canonicalize,
  canonicalBytes as sharedCanonicalBytes,
} from "@lerna-labs/ekklesia-helpers/json";

export { canonicalize };

export function canonicalBytes(value) {
  return Buffer.from(sharedCanonicalBytes(value));
}
