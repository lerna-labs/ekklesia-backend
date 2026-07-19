// Deterministic per-ballot voting-power allocation.
//
// For a given ballot + eligible voter list, produce per-voter
// `votingPower` values (in lovelace) such that:
//
//   - total ≈ uniform[40%, 60%] of Cardano max supply (45B ADA), per
//     ballot — i.e. the "Total Voting Power" / eligible universe
//   - distribution is power-law: a small number of whales hold the
//     bulk of the power, with a long tail of medium-to-small voters
//   - results are stable per (ballotId, userId) so re-running the
//     scaffold converges on the same numbers
//
// Active Voting Power (the participating subset) is computed by the
// vote seeder — that just sums UserCache.votingPower over voters that
// actually have Vote docs. Total vs Active comes naturally from
// "validated voters" vs "voters with Vote docs".

import crypto from 'node:crypto';

const ADA = 1_000_000n; // lovelace per ADA
const MAX_SUPPLY = 45_000_000_000n * ADA; // 45B ADA in lovelace

// Pseudo-random in [0, 1) keyed by salt + components.
function prand(...parts) {
  const buf = crypto.createHash('sha256').update(parts.join('|')).digest();
  return buf.readUInt32BE(0) / 0xffffffff;
}

/**
 * Pick a per-ballot eligible total in lovelace.
 * Uniform between 40% and 60% of MAX_SUPPLY.
 */
function eligibleTotalForBallot(ballotId) {
  const r = prand('eligibleTotal', ballotId);
  // Work in number space scaled by 1000 to keep precision; convert
  // back to BigInt at the end.
  const pctScaled = 400 + Math.floor(r * 200); // 400..599 → 0.400..0.599
  const total = (MAX_SUPPLY * BigInt(pctScaled)) / 1000n;
  return total;
}

/**
 * Generate a power-law share vector over `n` voters that sums to 1.
 * Whale-heavy: a handful of voters get most of the share. Returns
 * floats — caller scales to a BigInt total.
 *
 * Seeded so the same ballot + voter set always produces the same
 * distribution.
 */
function powerLawShares(ballotId, voterIds) {
  // Each voter gets a raw weight = 1 / rank^alpha, where rank is a
  // deterministic permutation of the voter list per ballot. alpha=1.4
  // gives a noticeable whale tail without making the smallest holder
  // implausibly tiny.
  const alpha = 1.4;
  const ranked = [...voterIds]
    .map((id) => ({ id, sort: prand('rank', ballotId, id) }))
    .sort((a, b) => a.sort - b.sort);

  const raw = ranked.map((v, i) => {
    const rank = i + 1;
    // Add per-voter jitter so two adjacent ranks aren't perfectly
    // 1/rank apart — looks more organic.
    const jitter = 0.7 + prand('jitter', ballotId, v.id) * 0.6;
    return { id: v.id, w: jitter / Math.pow(rank, alpha) };
  });
  const sum = raw.reduce((s, r) => s + r.w, 0);
  return Object.fromEntries(raw.map(({ id, w }) => [id, w / sum]));
}

/**
 * Given a ballot and the eligible voter list, return a map
 * `{ userId → votingPower (BigInt lovelace) }` summing to the per-ballot
 * eligible total. Floors to whole lovelace; rounding remainder gets
 * tacked onto the largest holder so the sum is exact.
 *
 * @param {string|object} ballotId — anything stringifiable to a stable id
 * @param {Array<{userId: string}>} voters
 * @returns {Map<string, bigint>}
 */
export function allocateBallotPower(ballotId, voters) {
  const id = String(ballotId);
  const voterIds = voters.map((v) => v.userId);
  if (voterIds.length === 0) return new Map();

  const total = eligibleTotalForBallot(id);
  const shares = powerLawShares(id, voterIds);

  const allocations = new Map();
  let used = 0n;
  let largestId = voterIds[0];
  let largestPower = 0n;

  for (const userId of voterIds) {
    const share = shares[userId];
    // BigInt math via scaling: floor(total * share)
    const scaled = BigInt(Math.floor(share * 1_000_000_000));
    const power = (total * scaled) / 1_000_000_000n;
    allocations.set(userId, power);
    used += power;
    if (power > largestPower) {
      largestPower = power;
      largestId = userId;
    }
  }

  // Park the rounding remainder on the largest holder so totals match.
  const remainder = total - used;
  if (remainder !== 0n) {
    allocations.set(largestId, allocations.get(largestId) + remainder);
  }

  return allocations;
}

/**
 * Decide deterministically whether a voter participates on a given
 * ballot, with a per-ballot turnout target.
 *
 *   closed → uniform[0.60, 0.95]
 *   live   → uniform[0.20, 0.70]
 *   upcoming → 0
 *
 * Active power vs eligible power then varies naturally per ballot.
 */
export function turnoutForBallot(ballotId, state) {
  const id = String(ballotId);
  if (state === 'upcoming') return 0;
  const r = prand('turnout', id);
  if (state === 'closed') return 0.6 + r * 0.35;
  return 0.2 + r * 0.5;
}

export function participates(ballotId, userId, turnout) {
  if (turnout <= 0) return false;
  return prand('participate', ballotId, userId) < turnout;
}
