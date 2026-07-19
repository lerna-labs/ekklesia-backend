// Map a bech32 voter ID to its credential HRP (used in the evidence
// bundle). The Hydra role space is closed at v1 — `drep`, `pool`,
// `stake`, plus `calidus` which maps to role `pool` on Hydra's side.
// `stake_test` collapses into `stake` (same role, testnet prefix).
// Payment addresses (`addr` / `addr_test`) are explicitly rejected;
// voters must register via their stake credential.

export function credentialHrp(bech32Id) {
  if (!bech32Id) return null;
  const lower = bech32Id.toLowerCase();
  if (lower.startsWith('drep')) return 'drep';
  if (lower.startsWith('pool')) return 'pool';
  if (lower.startsWith('stake_test') || lower.startsWith('stake')) return 'stake';
  if (lower.startsWith('calidus')) return 'calidus';
  return 'unknown';
}

// Canonical evidence `responderRole` derived from the credential. Hydra
// (post commit `2dc0650`) ignores any client-supplied responderRole and
// re-derives this server-side before evidence hashing, so the backend
// MUST match Hydra's mapping or the prelim hash returned at /draft will
// diverge from the on-chain hash at settlement.
//
// Mapping per `.claude/trds/HYDRA_ROLE_SPACE_V1.md`:
//   drep        → "drep"
//   pool        → "pool"
//   calidus     → "pool"  (calidus hot key represents the SPO)
//   stake       → "stake"
//   stake_test  → "stake" (testnet prefix, same role)
//   anything else → null  (route layer should reject)
export function responderRoleFor(bech32Id) {
  const hrp = credentialHrp(bech32Id);
  if (hrp === 'drep') return 'drep';
  if (hrp === 'pool') return 'pool';
  if (hrp === 'calidus') return 'pool';
  if (hrp === 'stake') return 'stake';
  return null;
}
