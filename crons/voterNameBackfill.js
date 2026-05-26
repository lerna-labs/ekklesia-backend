// Throttled name backfill for voters whose User row has no name yet.
//
// The voter directory surfaces `User.name` (drep name / handle) next
// to each bech32 id. That field is populated at login time by
// routes/api/v0/session.js, which calls fetchDrepName / fetchHandle.
// Two populations bypass that path:
//
//   1. Historical voters who voted before the User collection landed
//      and have not logged in since.
//   2. Multisig DRep logins, which currently upsert User without ever
//      resolving a name.
//
// This sweep picks up those voters slowly and politely:
//
//   * Candidate = distinct Vote.userId with submittedAt set, joined
//     against User. We only chase voters who actually appear in the
//     directory, not every wallet that ever requested a nonce.
//   * Skip rows where `name` is already set (resolved — don't re-hit
//     Koios) OR where `nameFetchedAt` was stamped within
//     RETRY_INTERVAL_MS (a recent attempt — let the value settle).
//   * Cap per tick to MAX_PER_TICK to keep Koios + Handle.me load low
//     and well below their rate limits. A backfill of ~100 voters
//     therefore completes over a handful of 10-minute ticks rather
//     than a single burst.
//   * Pool voters have no display-name source plumbed through helper/
//     koios.js today, so they're skipped here. Adding a pool-ticker
//     fetcher later would let us include them with a one-line addition.
//
// Each candidate gets a `nameFetchedAt: now` stamp regardless of
// whether the fetch returned a name — that's what gates the retry
// interval. Failed fetches converge to "we tried, here's null" rather
// than re-hitting Koios on every cron tick.

import { Vote } from "../schema/Vote.js";
import { User } from "../schema/User.js";
import { fetchDrepName, fetchHandle } from "../helper/koios.js";

// At ~1 req/sec per fetcher (Koios + Handle.me chain), 20 candidates
// per tick is ~30s of work — safely under the cron's 10-minute window.
const MAX_PER_TICK = 20;
// Don't retry a voter whose last fetch was within 24h. Keeps Koios
// load proportional to genuinely new voters, not to the unresolved
// long tail.
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Dispatch by voter-id HRP. fetchDrepName + fetchHandle each return
 * a string (name found), undefined (no name on record), or null (lookup
 * failed). Treat all three terminally — the nameFetchedAt stamp
 * provides the retry gate.
 *
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function resolveName(userId) {
  if (userId.startsWith("drep")) {
    const v = await fetchDrepName(userId);
    return v || null;
  }
  if (userId.startsWith("stake")) {
    const v = await fetchHandle(userId);
    return v || null;
  }
  // pool / addr / unknown HRPs — no display-name source today.
  return null;
}

/**
 * Walk distinct voter ids, upsert a name for the ones missing one.
 *
 * @returns {Promise<{candidates: number, attempted: number, resolved: number}>}
 */
export async function backfillVoterNames() {
  const ids = await Vote.distinct("userId", {
    submittedAt: { $ne: null },
    userId: { $type: "string" },
  });
  if (ids.length === 0) return { candidates: 0, attempted: 0, resolved: 0 };

  // Eligible HRPs only; otherwise resolveName always returns null and
  // we burn the daily retry budget on rows we have no plan for.
  const eligibleIds = ids.filter(
    (id) => id.startsWith("drep") || id.startsWith("stake")
  );

  // Pull existing User docs so we can filter out the already-resolved
  // and already-tried-recently population without a per-id round trip.
  const existing = await User.find({ _id: { $in: eligibleIds } })
    .select("_id name nameFetchedAt")
    .lean();
  const existingById = new Map(existing.map((u) => [u._id, u]));

  const cutoff = new Date(Date.now() - RETRY_INTERVAL_MS);
  const candidates = [];
  for (const id of eligibleIds) {
    const row = existingById.get(id);
    if (row?.name) continue;
    if (row?.nameFetchedAt && row.nameFetchedAt > cutoff) continue;
    candidates.push(id);
    if (candidates.length >= MAX_PER_TICK) break;
  }
  if (candidates.length === 0) {
    console.log("[voterNameBackfill] no candidates this tick");
    return { candidates: 0, attempted: 0, resolved: 0 };
  }
  console.log(
    `[voterNameBackfill] ${eligibleIds.length} eligible voter(s); ${candidates.length} candidate(s) this tick`
  );

  let attempted = 0;
  let resolved = 0;
  for (const userId of candidates) {
    attempted += 1;
    let name = null;
    try {
      name = await resolveName(userId);
    } catch (err) {
      console.warn(
        `[voterNameBackfill] resolve failed for ${userId}: ${err.message}`
      );
      name = null;
    }
    const setFields = { nameFetchedAt: new Date() };
    if (name) {
      setFields.name = name;
      resolved += 1;
    }
    try {
      // $setOnInsert pins lastLogin to null when this cron is what
      // *creates* the User row. The User schema defaults lastLogin to
      // Date.now, so without this an upserted row would falsely look
      // like the voter logged in at cron-run time. (Existing User
      // rows have a real lastLogin already and aren't touched here.)
      await User.findOneAndUpdate(
        { _id: userId },
        {
          $set: setFields,
          $setOnInsert: { lastLogin: null },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(
        `[voterNameBackfill] upsert failed for ${userId}: ${err.message}`
      );
    }
  }
  console.log(
    `[voterNameBackfill] attempted ${attempted}, resolved ${resolved}`
  );
  return { candidates: candidates.length, attempted, resolved };
}
