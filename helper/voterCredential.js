// Map a bech32 voter ID to its credential HRP (used in the evidence
// bundle). The Hydra role space is closed at v1 — `drep`, `pool`,
// `stake`, plus `calidus` which maps to role `pool` on Hydra's side.
// `stake_test` collapses into `stake` (same role, testnet prefix).
// Payment addresses (`addr` / `addr_test`) are explicitly rejected;
// voters must register via their stake credential.

export function credentialHrp(bech32Id) {
  if (!bech32Id) return null;
  const lower = bech32Id.toLowerCase();
  if (lower.startsWith("drep")) return "drep";
  if (lower.startsWith("pool")) return "pool";
  if (lower.startsWith("stake_test") || lower.startsWith("stake")) return "stake";
  if (lower.startsWith("calidus")) return "calidus";
  return "unknown";
}
