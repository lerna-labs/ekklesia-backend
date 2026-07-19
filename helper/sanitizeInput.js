// Phase 5: thin re-export. Implementation lives in
// @lerna-labs/ekklesia-helpers/validation. Kept as a shim so existing
// imports (./helper/sanitizeInput.js) continue to work without churn.
export { sanitizeInput } from '@lerna-labs/ekklesia-helpers/validation';
