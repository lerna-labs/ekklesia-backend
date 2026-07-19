// Phase 5 pass 2: thin re-export from @lerna-labs/ekklesia-helpers/crypto.
// Local implementation retired — the shared lib returns richer error objects
// ({error: "..."}) that align with what consumers and tests expect.
// Consumers (routes/api/v0/{session,dashboard}.js) defensively handle both
// shapes via `.error || !result` guards; frozen v0 write paths aren't hit.
export {
  verifySignature,
  isPartyToScript,
  validateScriptSignatures,
  getScriptCriteria,
} from '@lerna-labs/ekklesia-helpers/crypto';
