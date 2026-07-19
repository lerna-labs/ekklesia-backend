// Voting-power snapshot cron.
//
// Iterates ballots whose votingPowerSource.type === "snapshot" and
// upserts per-voter VoterPowerSnapshot rows by calling each ballot's
// configured script (or its default UserCache implementation).
//
// Skips:
//   - ballots whose source has transitioned to "uploaded" (admin
//     authoritative; cron must not touch)
//   - ballots whose source is "script" (live computation only;
//     deliberate opt-out from caching)
//   - closed ballots that aren't going to change (we still snapshot
//     them once but don't keep refreshing — leave the tally in the
//     state the last script call produced unless an admin uploads)
//
// Idempotent. Re-runs converge to the script's current output.

import { Ballot } from '../schema/Ballot.js';
import { VoterPowerSnapshot } from '../schema/VoterPowerSnapshot.js';
import { loadValidationScript } from '../helper/loadValidationScript.js';

const COMPUTED_BY = 'cron:15minVotingPower';

export async function snapshotVotingPower() {
  const ballots = await Ballot.find({
    'votingPowerSource.type': 'snapshot',
    status: { $in: ['upcoming', 'live'] },
  })
    .select('_id title votingPowerSource voterValidationScript')
    .lean();

  if (ballots.length === 0) {
    console.log('[15minVotingPower] no snapshot-mode open ballots');
    return { ballotsProcessed: 0, totalRowsWritten: 0 };
  }

  let totalRowsWritten = 0;
  let ballotsProcessed = 0;

  for (const ballot of ballots) {
    const scriptName = ballot.votingPowerSource?.scriptName || ballot.voterValidationScript;
    if (!scriptName) {
      console.warn(`[15minVotingPower] ${ballot._id} has no scriptName, skipping`);
      continue;
    }

    let mod;
    try {
      mod = await loadValidationScript(scriptName);
    } catch (err) {
      console.warn(`[15minVotingPower] ${ballot._id} failed to load ${scriptName}: ${err.message}`);
      continue;
    }
    if (typeof mod.computePerVoterPower !== 'function') {
      console.warn(
        `[15minVotingPower] ${ballot._id} script ${scriptName} doesn't export computePerVoterPower, skipping`,
      );
      continue;
    }

    let rows;
    try {
      rows = await mod.computePerVoterPower(ballot._id);
    } catch (err) {
      console.warn(`[15minVotingPower] ${ballot._id} computePerVoterPower failed: ${err.message}`);
      continue;
    }
    if (!Array.isArray(rows)) continue;

    const now = new Date();
    const userIds = new Set();
    for (const r of rows) {
      if (!r?.userId) continue;
      userIds.add(r.userId);
      await VoterPowerSnapshot.updateOne(
        { ballotId: ballot._id, userId: r.userId },
        {
          $set: {
            voterGroup: r.voterGroup || 'stake',
            votingPower: Number(r.votingPower) || 0,
            source: 'snapshot',
            computedAt: now,
            computedBy: COMPUTED_BY,
          },
        },
        { upsert: true },
      );
    }

    // Drop snapshot rows for voters that aren't in the latest computation
    // (they may have been removed from eligibility). Don't touch
    // "uploaded" rows — a transition guard, since this cron only runs
    // for source === "snapshot" but defense in depth.
    const stale = await VoterPowerSnapshot.deleteMany({
      ballotId: ballot._id,
      userId: { $nin: Array.from(userIds) },
      source: { $ne: 'uploaded' },
    });

    totalRowsWritten += rows.length;
    ballotsProcessed++;
    console.log(
      `[15minVotingPower] ${ballot._id} ${ballot.title} — ${rows.length} rows written, ${stale.deletedCount || 0} stale removed`,
    );
  }

  return { ballotsProcessed, totalRowsWritten };
}
