// Phase 5 pass 2: thin re-export from @lerna-labs/ekklesia-helpers/crypto.
// Local implementation retired — the shared lib returns richer error objects
// ({error: "..."}) that align with what consumers and tests expect.
// validateScriptSignatures resolves to `true`, `false`, or {error}. Callers
// must test for `=== true` and handle `.error` explicitly; a plain falsy
// check reads an error object as a passing result.
export {
  verifySignature,
  isPartyToScript,
  validateScriptSignatures,
  getScriptCriteria,
} from '@lerna-labs/ekklesia-helpers/crypto';
