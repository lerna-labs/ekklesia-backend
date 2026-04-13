// Phase 1 stub — returns empty until Phase 2 wires it to the Hydra service
// via helper/hydraClient.js. Once implemented, reads Hydra-backed ballots
// (source === "hydra") from their respective Hydra instances + local cache.

export const source = "hydra";

export function ownershipMatch() {
  return { source: "hydra" };
}

export async function list() {
  return { items: [], total: 0 };
}

export async function get() {
  return null;
}

export function toUnified() {
  throw new Error("hydraAdapter.toUnified not yet implemented (Phase 2)");
}
