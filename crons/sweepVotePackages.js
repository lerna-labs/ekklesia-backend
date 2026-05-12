// Stale VotePackage sweeper.
//
// Transitions any non-terminal VotePackage whose `lastActivityAt` is
// older than `VOTE_PACKAGE_TTL_MINUTES` (default 60) into the terminal
// `"abandoned"` status AND releases its reserved nonce back to
// UserCache. The nonce release is load-bearing: Hydra enforces
// `signedPayload.nonce === currentVersion + 1` strictly, so a burned-
// but-never-committed nonce would poison the voter's next draft.
//
// Intended to run from the 1-minute cron (crons/1min.js). Runs quickly
// — one indexed query + a few updates per stale package. Safe to call
// repeatedly; packages that hit the cutoff mid-call are picked up on
// the next tick.

import { VotePackage } from "../schema/VotePackage.js";
import * as nonceManager from "../helper/nonceManager.js";

const DEFAULT_TTL_MINUTES = 60;

const NON_TERMINAL_STATUSES = [
  "draft",
  "awaiting-signatures",
  "awaiting-submission",
];

function resolveTtlMinutes() {
  const raw = Number(process.env.VOTE_PACKAGE_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MINUTES;
  return raw;
}

/**
 * Sweep stale non-terminal packages.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMinutes] — override the env-derived TTL
 * @returns {Promise<{swept: number, ttlMinutes: number}>}
 */
export async function sweepStaleVotePackages({ ttlMinutes } = {}) {
  const ttl = ttlMinutes ?? resolveTtlMinutes();
  const cutoff = new Date(Date.now() - ttl * 60 * 1000);

  // `lastActivityAt` may be missing on packages that existed before
  // the schema added the field — fall back to `createdAt` via $or so
  // the sweep still reaps them.
  const stale = await VotePackage.find({
    status: { $in: NON_TERMINAL_STATUSES },
    $or: [
      { lastActivityAt: { $lt: cutoff } },
      { lastActivityAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
  }).lean();

  let swept = 0;
  for (const pkg of stale) {
    // Flip status first so a concurrent /signature or /submit call
    // hits a terminal package and bails cleanly.
    const update = await VotePackage.updateOne(
      { _id: pkg._id, status: { $in: NON_TERMINAL_STATUSES } },
      {
        $set: {
          status: "abandoned",
          failureReason: `TTL sweep: no activity in ${ttl} minutes`,
          lastActivityAt: new Date(),
        },
      }
    );
    if (update.modifiedCount === 0) continue;
    await nonceManager.release({
      userId: pkg.userId,
      ballotId: pkg.ballotId,
      nonce: pkg.nonce,
    });
    swept += 1;
  }

  if (swept > 0) {
    console.log(
      `[sweepVotePackages] abandoned ${swept} stale package(s) (TTL ${ttl}m)`
    );
  }
  return { swept, ttlMinutes: ttl };
}
