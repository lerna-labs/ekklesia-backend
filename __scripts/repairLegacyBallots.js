// One-off repair of legacy ballots created before the VoterCache to
// UserCache rename (Feb 28 2026), which shipped with no data migration.
//
// Such ballots store no `source` or `status`, keep voting power in the old
// `votercaches` collection, carry comments with only `voterId`, and may name
// a voter validation script that no longer exists in config/. For each named
// ballot this script:
//   - sets source "legacy" and status "closed" where they differ
//   - sets voterValidationScript to voterValidationAlwaysFalse.js
//   - copies votercaches rows into usercaches (existing rows are kept)
//   - sets userId (from voterId) and status "live" on comments lacking userId
//   - retallies every proposal with a forced provisional tally
//
// It refuses, writing nothing for any ballot, when a ballot does not exist,
// is not legacy, has not ended, or has votes without userId (run
// backfillVoteUserId.js first). Dry run by default; the recount runs only
// under --apply, because it reads the usercaches rows the repair writes.
//
// Usage:
//   node __scripts/repairLegacyBallots.js --ballot <id> [--ballot <id> ...]
//   node __scripts/repairLegacyBallots.js --ballot <id> --apply

import process from 'process';
import fs from 'fs';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { bootstrap, teardown } from './scaffold/common/env.js';
import { Ballot } from '../schema/Ballot.js';
import { Question } from '../schema/Question.js';
import { Vote } from '../schema/Vote.js';
import { Comment } from '../schema/Comment.js';
import { UserCache } from '../schema/UserCache.js';
import { Result } from '../schema/Result.js';
import { responderRoleFor } from '../helper/voterCredential.js';
import { tallyProposalProvisional } from '../crons/10minAggregateVotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const configDir = join(here, '..', 'config');
const REPLACEMENT_SCRIPT = 'voterValidationAlwaysFalse.js';

export function parseBallotArgs(argv) {
  const ballotIds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ballot' && i + 1 < argv.length) ballotIds.push(argv[++i]);
    else if (argv[i].startsWith('--ballot=')) ballotIds.push(argv[i].slice('--ballot='.length));
  }
  return { ballotIds, apply: argv.includes('--apply') };
}

// Returns the ballot fields that differ from the repaired shape, as { field: { from, to } }.
export function planBallotChanges(ballot) {
  const wanted = { source: 'legacy', status: 'closed', voterValidationScript: REPLACEMENT_SCRIPT };
  const changes = {};
  for (const [field, to] of Object.entries(wanted)) {
    if (ballot[field] !== to) changes[field] = { from: ballot[field], to };
  }
  return changes;
}

// Returns the reasons a ballot must not be repaired, empty when it may be.
export function refusalReasons(ballot, { now, unattributedVotes }) {
  if (!ballot) return ['ballot does not exist'];
  const reasons = [];
  if ((ballot.source ?? 'legacy') !== 'legacy') {
    reasons.push(`source is "${ballot.source}", not legacy`);
  }
  if (!ballot.votePeriodEnd || new Date(ballot.votePeriodEnd) > now) {
    reasons.push('votePeriodEnd is missing or in the future');
  }
  if (unattributedVotes > 0) {
    reasons.push(
      `${unattributedVotes} vote(s) have no userId; run __scripts/backfillVoteUserId.js first`,
    );
  }
  return reasons;
}

// Splits votercaches rows into rows to insert and rows to report.
export function planUserCacheCopy(rows, existingByUserId) {
  const plan = { insert: [], badPrefix: [], same: [], differ: [], duplicate: [] };
  const seen = new Set();
  for (const row of rows) {
    const userId = row.voterId;
    const voterGroup = responderRoleFor(userId);
    if (!voterGroup) {
      plan.badPrefix.push(userId);
      continue;
    }
    if (seen.has(userId)) {
      plan.duplicate.push(userId);
      continue;
    }
    seen.add(userId);
    const wanted = {
      userId,
      ballotId: row.ballotId,
      validated: row.validated,
      votingPower: row.votingPower,
      voterGroup,
    };
    const existing = existingByUserId.get(userId);
    if (!existing) plan.insert.push(wanted);
    else if (
      existing.validated === wanted.validated &&
      existing.votingPower === wanted.votingPower &&
      existing.voterGroup === wanted.voterGroup
    ) {
      plan.same.push(userId);
    } else plan.differ.push({ userId, existing, wanted });
  }
  return plan;
}

const showResult = (r) =>
  r?.results
    ? r.results.map((o) => `${o.id}: count=${o.count} votingPower=${o.votingPower}`).join('; ')
    : '(no stored result)';

export async function repairLegacyBallots(ballotIds, { apply = false, now = new Date() } = {}) {
  const log = (m) => console.log(`[repair] ${m}`);
  const states = [];
  let refused = false;

  for (const id of ballotIds) {
    const ballot = mongoose.isValidObjectId(id)
      ? await Ballot.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })
      : null;
    const proposals = ballot
      ? await Question.find({ ballotId: ballot._id }).select('_id').lean()
      : [];
    const proposalIds = proposals.map((p) => p._id);
    const unattributedVotes = ballot
      ? await Vote.collection.countDocuments({ proposalId: { $in: proposalIds }, userId: null })
      : 0;
    const reasons = refusalReasons(ballot, { now, unattributedVotes });
    if (reasons.length) {
      refused = true;
      for (const r of reasons) console.error(`[repair] refusing ballot ${id}: ${r}`);
    }
    states.push({ id, ballot, proposalIds });
  }
  if (refused) {
    console.error('[repair] nothing written');
    return { refused: true, changed: 0 };
  }

  let changed = 0;
  for (const { id, ballot, proposalIds } of states) {
    log(`ballot ${id} (${apply ? 'APPLY' : 'dry run'})`);

    const changes = planBallotChanges(ballot);
    const oldScript = ballot.voterValidationScript;
    const scriptExists = oldScript ? fs.existsSync(join(configDir, oldScript)) : false;
    log(`  voterValidationScript was ${oldScript} (exists in config/: ${scriptExists})`);
    for (const [field, { from, to }] of Object.entries(changes)) {
      log(`  ballot.${field}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    }
    if (Object.keys(changes).length) {
      changed++;
      if (apply) {
        const $set = Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to]));
        await Ballot.updateOne({ _id: ballot._id }, { $set });
      }
    }

    const rows = await UserCache.db
      .collection('votercaches')
      .find({ ballotId: { $in: [ballot._id, String(ballot._id)] } })
      .toArray();
    const existing = await UserCache.find({ ballotId: ballot._id }).lean();
    const plan = planUserCacheCopy(
      rows.map((r) => ({ ...r, ballotId: ballot._id })),
      new Map(existing.map((e) => [e.userId, e])),
    );
    log(
      `  votercaches rows=${rows.length} insert=${plan.insert.length} already-present=${plan.same.length} differ=${plan.differ.length} unknown-prefix=${plan.badPrefix.length} duplicate=${plan.duplicate.length}`,
    );
    for (const u of plan.badPrefix) log(`  skipped, unknown prefix: ${u}`);
    for (const u of plan.duplicate) log(`  skipped, duplicate votercaches row: ${u}`);
    for (const d of plan.differ) {
      log(
        `  existing usercaches differs, kept: ${d.userId} existing=${JSON.stringify({ validated: d.existing.validated, votingPower: d.existing.votingPower, voterGroup: d.existing.voterGroup })} votercaches=${JSON.stringify({ validated: d.wanted.validated, votingPower: d.wanted.votingPower, voterGroup: d.wanted.voterGroup })}`,
      );
    }
    for (const w of plan.insert) {
      log(
        `  insert usercaches ${w.userId} group=${w.voterGroup} power=${w.votingPower} validated=${w.validated} (no previous row)`,
      );
    }
    if (plan.insert.length) {
      changed++;
      if (apply) await UserCache.insertMany(plan.insert);
    }

    const comments = await Comment.collection
      .find({ proposalId: { $in: proposalIds }, userId: null })
      .toArray();
    log(`  comments without userId: ${comments.length}`);
    for (const c of comments) {
      if (!c.voterId) {
        log(`  skipped comment ${c._id}: no voterId`);
        continue;
      }
      log(
        `  comment ${c._id}: userId (none) -> ${c.voterId}, status ${JSON.stringify(c.status)} -> "live"`,
      );
      changed++;
      if (apply) {
        await Comment.collection.updateOne(
          { _id: c._id },
          { $set: { userId: c.voterId, status: 'live' } },
        );
      }
    }

    const ballotCache = new Map();
    if (!apply) log('  recount runs only under --apply; stored results:');
    for (const proposalId of proposalIds) {
      const before = await Result.findOne({ proposalId }).lean();
      log(`  proposal ${proposalId} stored: ${showResult(before)}`);
      if (apply) {
        const outcome = await tallyProposalProvisional(proposalId, { ballotCache, force: true });
        const after = await Result.findOne({ proposalId }).lean();
        log(`  proposal ${proposalId} recount (${outcome}): ${showResult(after)}`);
      }
    }
  }

  log(
    changed === 0
      ? 'nothing to change (the recount only rewrites identical figures)'
      : `${changed} change group(s) ${apply ? 'applied' : 'pending'}`,
  );
  return { refused: false, changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ballotIds, apply } = parseBallotArgs(process.argv.slice(2));
  if (ballotIds.length === 0) {
    console.error(
      'usage: node __scripts/repairLegacyBallots.js --ballot <id> [--ballot <id> ...] [--apply]',
    );
    process.exit(1);
  }
  await bootstrap();
  let code = 0;
  try {
    const { refused } = await repairLegacyBallots(ballotIds, { apply });
    if (refused) code = 1;
  } catch (err) {
    console.error(`[repair] failed: ${err.stack || err.message}`);
    code = 2;
  }
  await teardown();
  process.exit(code);
}
