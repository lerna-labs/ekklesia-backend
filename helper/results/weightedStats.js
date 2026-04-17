// Per-option per-group tally for the "weighted" vote type (Hydra's
// `weighted` method — voter distributes `budget` integer points across
// options, Σ values must equal voterBudget).
//
// Output shape mirrors Hydra v2 WeightedOptionTally[] so finalized
// ballots can swap this for Hydra's tally without UI churn:
//
//   [{ option, totalPoints, voterCount, mean, stdDev }]
//
// Note on voting-power weighting:
//   When `voteWeighted` is true the scaffold also publishes a second
//   `weightedByPower` array where each voter's contribution is scaled
//   by their votingPower. This is a backend/UI convenience and is
//   NOT what Hydra's tally reports — Hydra deliberately drops
//   stake-weighting (v2 TRD §4), leaving it to the voting authority.

function descriptiveStats(values) {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Compute weighted stats for one voter group's votes on one proposal.
 *
 * @param {Object} args
 * @param {Object} args.proposal — needs voteOptions, voterBudget
 * @param {Array<{userId, vote: Array<{option, value}>}>} args.votes
 * @param {Map<string, {voterGroup, votingPower}>} args.votersByUserId
 * @param {boolean} args.voteWeighted — when true, also emits power-weighted totals
 * @returns {object|null}
 */
export function computeWeightedStats({ proposal, votes, votersByUserId, voteWeighted }) {
  const options = (proposal.voteOptions || []).filter((o) => o.id !== "abstain");
  if (options.length === 0) return null;

  const perOption = new Map();
  for (const o of options) {
    perOption.set(o.id, { values: [], powerValues: [] });
  }

  let voterCount = 0;
  for (const v of votes) {
    const voter = votersByUserId?.get(v.userId);
    const power = voter?.votingPower ?? 1;
    const entries = Array.isArray(v.vote) ? v.vote : [];
    let voterContributed = false;
    for (const e of entries) {
      if (e == null || typeof e !== "object") continue;
      const bucket = perOption.get(e.option);
      if (!bucket) continue;
      const value = Number(e.value);
      if (!Number.isFinite(value) || value < 0) continue;
      bucket.values.push(value);
      bucket.powerValues.push(value * power);
      voterContributed = true;
    }
    if (voterContributed) voterCount += 1;
  }

  const results = options.map((o) => {
    const { values, powerValues } = perOption.get(o.id) || { values: [], powerValues: [] };
    const totalPoints = values.reduce((s, v) => s + v, 0);
    const nonzeroVoters = values.filter((v) => v > 0).length;
    const { mean, stdDev } = descriptiveStats(values);
    const row = {
      option: o.id,
      label: o.label,
      totalPoints,
      voterCount: nonzeroVoters,
      mean,
      stdDev,
    };
    if (voteWeighted) {
      const powerTotal = powerValues.reduce((s, v) => s + v, 0);
      row.powerTotalPoints = powerTotal;
      row.powerMean = nonzeroVoters > 0 ? powerTotal / nonzeroVoters : 0;
    }
    return row;
  });

  return {
    budget: Number(proposal.voterBudget) || 0,
    voterCount,
    results,
  };
}

/**
 * Bucket raw weighted votes by voter group. Abstain votes are dropped
 * (they contribute to the parent tally's abstain row, not to the
 * per-option weighted aggregate).
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
    if (first === "abstain") continue;
    const group = voter.voterGroup || "default";
    if (!out.has(group)) out.set(group, []);
    out.get(group).push(v);
  }
  return out;
}
