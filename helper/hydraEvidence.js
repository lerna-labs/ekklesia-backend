// Hydra audit-evidence helpers.
//
// The Hydra middleware's /audit/full endpoint returns the complete per-voter
// evidence bundle for a finalized ballot (and also live for pre-finalize
// tallies). This module shapes that bundle into the `{userId, vote}` form
// that the existing per-ballot tally helpers under `helper/results/` already
// consume — so the final tally path uses the same math as the provisional
// cron instead of a parallel derivation from Hydra's aggregate summaries.
//
// Evidence shape (see ~/ekklesia/hydra/src/types.ts — VoteEvidence,
// VoteSelection, SelectionEntry):
//
//   /audit/full → {
//     ballot, totalVoters,
//     voters: Array<{
//       voterId: "<bech32 drep/pool/stake/calidus>",
//       credentialHrp: "drep" | "pool" | "stake" | "calidus" | "stake_test",
//       evidence: {
//         specVersion, responderRole,
//         answers: [{ questionId, abstain?, selection? }, ...],
//         ekklesia: { ... },
//       } | null,
//       history, proof, ...
//     }>
//   }
//
// The `selection` field is method-dependent:
//   - binary / single-choice / multi-choice / range (scale) / ranked →
//     `number[]` (option ids, ordered for ranked, single-element for range)
//   - weighted / likert → `SelectionEntry[]` (`{option, value}` pairs)
//   - abstain → absent; `abstain: true` set instead
//
// The existing helpers (see crons/10minAggregateVotes.js:246-307) want
// `{userId, vote}` where `vote` is exactly the array that used to live on
// `Vote.submittedVote`:
//   - choice / ranked / scale → `[number, ...]`
//   - likert / weighted        → `[{option, value}, ...]`
//   - abstain                  → `["abstain"]`
//
// `voteFromAnswer` converts one VoteSelection to that shape.

/**
 * Convert a Hydra `VoteSelection` to the `Vote.submittedVote` array shape the
 * per-ballot helpers consume.
 *
 * @param {object} answer — { questionId, abstain?: true, selection?: number[] | {option,value}[] }
 * @returns {Array<number|string|{option:number,value:number}> | null}
 *   Returns `null` when the answer is malformed (no abstain flag and no
 *   selection). Callers should skip null rows.
 */
export function voteFromAnswer(answer) {
  if (!answer) return null;
  if (answer.abstain === true) return ["abstain"];
  if (!Array.isArray(answer.selection)) return null;
  // For the helpers, the array content passes through unchanged:
  // number[] stays number[]; SelectionEntry[] stays SelectionEntry[].
  return answer.selection;
}

/**
 * Extract per-voter `{userId, vote}` rows for a single proposal from a full
 * audit bundle.
 *
 * @param {object} auditFull — the `/audit/full` response envelope's data
 * @param {string} proposalId — the question's _id as a string
 * @returns {Array<{userId: string, vote: Array}>}
 *   Voters who have no `evidence` (pre-vote placeholders) and voters who
 *   didn't answer this proposal are skipped. Malformed answers are skipped.
 */
export function votesForProposal(auditFull, proposalId) {
  const voters = Array.isArray(auditFull?.voters) ? auditFull.voters : [];
  const out = [];
  for (const voter of voters) {
    const evidence = voter?.evidence;
    if (!evidence) continue;
    const answers = Array.isArray(evidence.answers) ? evidence.answers : [];
    const match = answers.find((a) => a && a.questionId === proposalId);
    if (!match) continue;
    const vote = voteFromAnswer(match);
    if (!vote) continue;
    out.push({ userId: voter.voterId, vote });
  }
  return out;
}

/**
 * Collect the distinct voter ids present in an audit bundle. Used to batch-
 * load UserCache rows for voterGroup + votingPower lookups.
 *
 * @param {object} auditFull
 * @returns {string[]}
 */
export function voterIdsIn(auditFull) {
  const voters = Array.isArray(auditFull?.voters) ? auditFull.voters : [];
  return voters.map((v) => v?.voterId).filter(Boolean);
}

/**
 * Infer `voterGroup` from the bech32 HRP on the evidence when no UserCache
 * row exists (e.g. final tally running before a provisional cron ever ran).
 *
 * Mapping matches the `voterGroups` convention used throughout the backend:
 *   drep            → "drep"
 *   pool / calidus  → "pool"    (calidus is an SPO hot key)
 *   stake / stake_test → "stake"
 *   anything else   → "default"
 *
 * @param {string|undefined|null} credentialHrp
 * @returns {string}
 */
export function voterGroupFromHrp(credentialHrp) {
  const hrp = String(credentialHrp || "").toLowerCase();
  if (hrp === "drep") return "drep";
  if (hrp === "pool" || hrp === "calidus") return "pool";
  if (hrp === "stake" || hrp === "stake_test") return "stake";
  return "default";
}

/**
 * Build a `{userId → {voterGroup, votingPower}}` Map for the voters in the
 * audit bundle. Prefers the UserCache row (written during /draft eligibility
 * validation) so the final tally matches the provisional cron. Falls back to
 * `voterGroupFromHrp` + votingPower `1` when no UserCache row exists, which
 * keeps final tallies computable even on ballots the provisional cron never
 * ran on.
 *
 * @param {object} auditFull
 * @param {import('mongoose').ObjectId|string} ballotId
 * @param {import('mongoose').Model} UserCacheModel — passed in to avoid
 *   a circular import; the cron already has the model handy.
 * @returns {Promise<Map<string, {voterGroup: string, votingPower: number}>>}
 */
export async function buildVotersByUserId(auditFull, ballotId, UserCacheModel) {
  const voters = Array.isArray(auditFull?.voters) ? auditFull.voters : [];
  const ids = voters.map((v) => v?.voterId).filter(Boolean);
  const cached = ids.length
    ? await UserCacheModel.find({ ballotId, userId: { $in: ids } })
        .select("userId voterGroup votingPower")
        .lean()
    : [];
  const byId = new Map();
  for (const row of cached) byId.set(row.userId, row);
  const out = new Map();
  for (const v of voters) {
    const hit = byId.get(v.voterId);
    out.set(v.voterId, {
      userId: v.voterId,
      voterGroup: hit?.voterGroup || voterGroupFromHrp(v.credentialHrp),
      votingPower: typeof hit?.votingPower === "number" ? hit.votingPower : 1,
    });
  }
  return out;
}
