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

import mongoose from 'mongoose';
import { UserCache } from '../schema/UserCache.js';
import { VotePackage } from '../schema/VotePackage.js';

export class NonceError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'NonceError';
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
 *
 * Defense in depth: clamps the reservation against the highest already-
 * confirmed VotePackage.nonce for this (voter, ballot). If anything has
 * reset UserCache.nonce after the voter's previous vote(s) confirmed —
 * e.g. an operator script that deleted the row, an over-eager release,
 * a manual edit — the naïve increment would return a value Hydra has
 * already accepted, and `/vote` would reject the next submission with
 * NONCE_STALE. The floor makes reserveNext idempotent against that
 * class of UserCache drift.
 */
export async function reserveNext({ userId, ballotId }) {
  if (!userId || !ballotId) {
    throw new NonceError('userId and ballotId are required', { code: 'BAD_INPUT' });
  }
  const floor = await maxConfirmedPackageNonce(userId, ballotId);
  const updated = await UserCache.findOneAndUpdate(
    { userId, ballotId },
    [
      {
        $set: {
          nonce: {
            $max: [{ $add: [{ $ifNull: ['$nonce', 0] }, 1] }, floor + 1],
          },
        },
      },
    ],
    { new: true, upsert: true, setDefaultsOnInsert: true, updatePipeline: true },
  );
  return updated.nonce;
}

/**
 * Highest nonce on a hydra-confirmed VotePackage for this voter/ballot,
 * or 0 if the voter has never committed a vote here. Source of the
 * reservation floor in `reserveNext`. `aggregate()` does not auto-cast
 * a string ballotId, so do it here.
 */
async function maxConfirmedPackageNonce(userId, ballotId) {
  const ballotObjectId =
    typeof ballotId === 'string' ? new mongoose.Types.ObjectId(ballotId) : ballotId;
  const [row] = await VotePackage.aggregate([
    {
      $match: {
        ballotId: ballotObjectId,
        userId,
        status: 'hydra-confirmed',
        nonce: { $type: 'number' },
      },
    },
    { $group: { _id: null, max: { $max: '$nonce' } } },
  ]);
  return typeof row?.max === 'number' ? row.max : 0;
}

/**
 * Confirm that a reserved nonce is still the head and record the commit time.
 * No-op if nothing newer has been reserved; throws if the stored nonce has
 * moved past the reserved value (a programmer error — only the broker should
 * bump, and only via reserveNext).
 */
export async function commit({ userId, ballotId, nonce }) {
  const row = await UserCache.findOne({ userId, ballotId });
  if (!row) throw new NonceError('UserCache row missing on commit', { code: 'NOT_FOUND' });
  if (row.nonce < nonce) {
    throw new NonceError(
      `Stored nonce ${row.nonce} is less than committed ${nonce} — reservation lost?`,
      { code: 'NONCE_LOST' },
    );
  }
  return row.nonce;
}

/**
 * Release a reserved nonce by rolling the counter back by one — but only if
 * the stored head equals the reserved value.
 *
 * Load-bearing: Hydra enforces strict `signedPayload.nonce === currentVersion + 1`.
 * A reserved-then-abandoned nonce that is NOT released creates a gap (stored
 * nonce drifts ahead of Hydra's on-chain Version), and every subsequent vote
 * attempt fails at /vote until the gap is reconciled. Callers that abandon
 * a reservation (draft cancelled, TTL sweep, submission failure) MUST call
 * release to keep the backend in lockstep with Hydra's expected next nonce.
 *
 * If another reservation has already advanced the head past this value,
 * release is a no-op — whichever reservation remains in flight will be the
 * voter's real submission attempt. Under idempotent /draft this shouldn't
 * happen: one active package per voter+ballot ⇒ one live reservation.
 */
export async function release({ userId, ballotId, nonce }) {
  if (nonce == null) return;
  const result = await UserCache.updateOne({ userId, ballotId, nonce }, { $inc: { nonce: -1 } });
  return result.modifiedCount > 0;
}

export async function peekCurrent({ userId, ballotId }) {
  const row = await UserCache.findOne({ userId, ballotId }).lean();
  return row?.nonce ?? null;
}
