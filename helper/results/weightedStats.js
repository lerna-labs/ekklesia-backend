// Per-option per-group tally for the "weighted" vote type (Hydra's
// `weighted` method — voter distributes `budget` integer points across
// options, Σ values must equal voterBudget).
//
// Output shape mirrors Hydra v2 WeightedOptionTally[] so finalized
// ballots can swap this for Hydra's tally without UI churn:
//
//   [{ option, totalPoints, voterCount, mean, stdDev }]
//
// Invariants (matches Hydra's published semantics):
//   - answeringBallots = non-abstain voters who submitted this question.
//     Caller passes a pre-filtered `votes` array (see bucketWeightedVotesByGroup);
//     internally we treat votes.length AS answeringBallots.
//   - voterCount (per option) = voters whose VALUE for this option is > 0.
//     Voters who omitted the option or submitted value 0 do NOT count
//     toward voterCount, but they DO count toward the mean/stdDev
//     denominator (as implicit zeros).
//   - mean = totalPoints / answeringBallots. Voters who allocated 0
//     contribute to the denominator, making this "mean over all
//     answering ballots" rather than "mean among contributors." A
//     consumer who wants the latter can compute totalPoints / voterCount.
//   - stdDev is the population stdDev over the full answeringBallots
//     vector (zero-filled for non-allocators).
//
// Note on voting-power weighting:
//   When `voteWeighted` is true the scaffold also publishes
//   `powerTotalPoints` + `powerMean` per option. This is a backend/UI
//   convenience and is NOT part of Hydra's tally — Hydra deliberately
//   drops stake-weighting (v2 TRD §4), leaving it to the voting authority.

/**
 * Compute weighted stats for one voter group's votes on one proposal.
 *
 * @param {Object} args
 * @param {Object} args.proposal — needs voteOptions, voterBudget
 * @param {Array<{userId, vote: Array<{option, value}>}>} args.votes — non-abstain votes for this group
 * @param {Map<string, {voterGroup, votingPower}>} args.votersByUserId
 * @param {boolean} args.voteWeighted — when true, also emits power-weighted totals
 * @returns {object|null}
 */
export function computeWeightedStats({ proposal, votes, votersByUserId, voteWeighted }) {
  const options = (proposal.voteOptions || []).filter((o) => o.id !== 'abstain');
  if (options.length === 0) return null;

  const answeringBallots = votes.length;

  // Per option: an array of contributions parallel to `votes` — one
  // number per voter, 0 if they didn't allocate. This zero-filling is
  // what makes the mean/stdDev match Hydra's answeringBallots semantics.
  const perOption = new Map();
  for (const o of options) {
    perOption.set(o.id, { contribs: [], powerContribs: [] });
  }

  for (const v of votes) {
    const voter = votersByUserId?.get(v.userId);
    const power = voter?.votingPower ?? 1;
    const entries = Array.isArray(v.vote) ? v.vote : [];

    // Index this voter's entries by option for O(1) lookup.
    const byOption = new Map();
    for (const e of entries) {
      if (e == null || typeof e !== 'object') continue;
      const value = Number(e.value);
      if (!Number.isFinite(value) || value < 0) continue;
      byOption.set(e.option, value);
    }

    for (const o of options) {
      const bucket = perOption.get(o.id);
      const value = byOption.get(o.id) ?? 0; // implicit zero for non-allocators
      bucket.contribs.push(value);
      bucket.powerContribs.push(value * power);
    }
  }

  const results = options.map((o) => {
    const { contribs, powerContribs } = perOption.get(o.id);
    const totalPoints = contribs.reduce((s, v) => s + v, 0);
    const voterCount = contribs.filter((v) => v > 0).length;
    const mean = answeringBallots > 0 ? totalPoints / answeringBallots : 0;
    const variance =
      answeringBallots > 0
        ? contribs.reduce((s, v) => s + (v - mean) ** 2, 0) / answeringBallots
        : 0;
    const stdDev = Math.sqrt(variance);
    const row = {
      option: o.id,
      label: o.label,
      totalPoints,
      voterCount,
      mean,
      stdDev,
    };
    if (voteWeighted) {
      const powerTotal = powerContribs.reduce((s, v) => s + v, 0);
      row.powerTotalPoints = powerTotal;
      row.powerMean = answeringBallots > 0 ? powerTotal / answeringBallots : 0;
    }
    return row;
  });

  return {
    budget: Number(proposal.voterBudget) || 0,
    answeringBallots,
    results,
  };
}

/**
 * Bucket raw weighted votes by voter group. Abstain votes are dropped
 * (they contribute to the question's abstainedByRole counter, not to
 * the per-option weighted aggregate).
 *
 * @param {Array} votes — { userId, vote: [{option, value}] | ["abstain"] }
 * @param {Map<string, {voterGroup, votingPower}>} votersByUserId
 * @returns {Map<string, Array<{userId, vote}>>}
 */
export function bucketWeightedVotesByGroup(votes, votersByUserId) {
  const out = new Map();
  for (const v of votes) {
    const voter = votersByUserId.get(v.userId);
    if (!voter) continue;
    const first = Array.isArray(v.vote) ? v.vote[0] : v.vote;
    if (first === 'abstain') continue;
    const group = voter.voterGroup || 'stake';
    if (!out.has(group)) out.set(group, []);
    out.get(group).push(v);
  }
  return out;
}
