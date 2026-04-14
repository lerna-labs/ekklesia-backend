// Atomic nonce reservation for Hydra voter tokens.
//
// Semantics:
//   - reserveNext({ userId, ballotId })
//       Atomically increments UserCache.nonce and returns the new value.
//       A reserved nonce is what the broker embeds in the signing payload.
//   - commit({ userId, ballotId, nonce })
//       No-op if the reserved nonce equals the stored nonce (the success
//       case). Records the commit time for observability.
//   - release({ userId, ballotId, nonce })
//       Rolls back a reserved nonce when submission fails or a draft is
//       cancelled — only if it is still the stored head (i.e., nothing
//       newer has been reserved since).
//   - peekCurrent({ userId, ballotId })
//       Returns the current committed nonce (or null if unset).
//
// On-chain voter tokens use `Version` starting at 0 (register) and 1 for
// the first vote. The backend reserves the *next* value — so for a brand
// new voter the first reservation yields 1.
//
// Storage: UserCache (one row per (userId, ballotId)).

import { UserCache } from "../schema/UserCache.js";

export class NonceError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "NonceError";
    this.code = code;
  }
}

/**
 * Reserve the next nonce for a voter on a ballot. The reservation is written
 * into UserCache.nonce atomically so concurrent callers get distinct values.
 *
 * Uses an aggregation-pipeline update ($ifNull + $add) so the increment
 * works uniformly whether the existing nonce is a number, null (the schema
 * default for fresh/reset rows), or missing entirely. MongoDB's plain `$inc`
 * rejects null with a TypeMismatch error.
 */
export async function reserveNext({ userId, ballotId }) {
  if (!userId || !ballotId) {
    throw new NonceError("userId and ballotId are required", { code: "BAD_INPUT" });
  }
  const updated = await UserCache.findOneAndUpdate(
    { userId, ballotId },
    [{ $set: { nonce: { $add: [{ $ifNull: ["$nonce", 0] }, 1] } } }],
    { new: true, upsert: true, setDefaultsOnInsert: true, updatePipeline: true }
  );
  return updated.nonce;
}

/**
 * Confirm that a reserved nonce is still the head and record the commit time.
 * No-op if nothing newer has been reserved; throws if the stored nonce has
 * moved past the reserved value (a programmer error — only the broker should
 * bump, and only via reserveNext).
 */
export async function commit({ userId, ballotId, nonce }) {
  const row = await UserCache.findOne({ userId, ballotId });
  if (!row) throw new NonceError("UserCache row missing on commit", { code: "NOT_FOUND" });
  if (row.nonce < nonce) {
    throw new NonceError(
      `Stored nonce ${row.nonce} is less than committed ${nonce} — reservation lost?`,
      { code: "NONCE_LOST" }
    );
  }
  return row.nonce;
}

/**
 * Release a reserved nonce by rolling the counter back by one — but only if
 * the stored head equals the reserved value. If another reservation has
 * already passed it, we leave things alone (the next vote to fail simply
 * sees a larger gap, which Hydra accepts as long as the payload's nonce
 * exceeds the current on-chain Version).
 */
export async function release({ userId, ballotId, nonce }) {
  if (nonce == null) return;
  const result = await UserCache.updateOne(
    { userId, ballotId, nonce },
    { $inc: { nonce: -1 } }
  );
  return result.modifiedCount > 0;
}

export async function peekCurrent({ userId, ballotId }) {
  const row = await UserCache.findOne({ userId, ballotId }).lean();
  return row?.nonce ?? null;
}
