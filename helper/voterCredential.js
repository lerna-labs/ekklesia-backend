// Map a bech32 voter ID to its credential HRP (used in the evidence bundle).

export function credentialHrp(bech32Id) {
  if (!bech32Id) return null;
  const lower = bech32Id.toLowerCase();
  if (lower.startsWith("drep")) return "drep";
  if (lower.startsWith("pool")) return "pool";
  if (lower.startsWith("stake_test") || lower.startsWith("stake")) return "stake";
  if (lower.startsWith("addr")) return "addr_vkh";
  if (lower.startsWith("calidus")) return "calidus";
  return "unknown";
}
