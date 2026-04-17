// Per-option per-group Likert aggregation + Majority Judgment ranking.
//
// Each option in a likert proposal is independently rated on a discrete
// scale (e.g. 1-5). Results carry:
//   - per-option descriptive stats (count, mean, median, mode, stdDev)
//   - per-option distribution (count at each grade)
//   - per-option powerDistribution (voting power at each grade)
//   - Majority Judgment ranking (weighted-median → tie-break)
//
// MJ algorithm:
//   1. For each option, cumulate powerDistribution from highest grade
//      downward. The grade where cumulative power ≥ 50% of totalPower
//      is the weighted median.
//   2. Rank options by median grade (descending).
//   3. Tie-break #1: higher share of power above the median → wins.
//   4. Tie-break #2: lower share of power below the median → wins.
//   5. Remaining ties are flagged — the voting authority resolves
//      manually per their governance rules.

function descriptiveStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / sorted.length;
  const variance =
    sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const counts = new Map();
  for (const v of sorted) counts.set(v, (counts.get(v) || 0) + 1);
  let maxCount = 0;
  for (const c of counts.values()) if (c > maxCount) maxCount = c;
  let mode = null;
  if (maxCount > 1) {
    const winners = [];
    for (const [v, c] of counts.entries()) if (c === maxCount) winners.push(v);
    mode = winners.length === 1 ? winners[0] : winners;
  }
  function quantile(q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const frac = pos - lo;
    return sorted[lo + 1] !== undefined
      ? sorted[lo] + frac * (sorted[lo + 1] - sorted[lo])
      : sorted[lo];
  }
  return {
    count: sorted.length,
    mean,
    median: quantile(0.5),
    mode,
    stdDev: Math.sqrt(variance),
  };
}

function buildDistribution(values, min, max) {
  const size = max - min + 1;
  const dist = new Array(size).fill(0);
  for (const v of values) {
    const idx = Math.round(v) - min;
    if (idx >= 0 && idx < size) dist[idx]++;
  }
  return dist;
}

function buildPowerDistribution(samples, min, max) {
  const size = max - min + 1;
  const dist = new Array(size).fill(0);
  let total = 0;
  for (const s of samples) {
    const idx = Math.round(s.rating) - min;
    if (idx >= 0 && idx < size) {
      dist[idx] += s.power;
      total += s.power;
    }
  }
  return { powerDistribution: dist, totalPower: total };
}

/**
 * Majority Judgment ranking from power distributions.
 *
 * @param {Array<{id, label, powerDist: number[], totalPower: number}>} entries
 * @param {number} min - ratingRange.min
 * @returns {Array<{id, label, medianGrade, supportAbove, oppositionBelow, tied}>}
 */
function majorityJudgment(entries, min) {
  const ranked = entries.map((e) => {
    const total = e.totalPower;
    if (total === 0) {
      return { id: e.id, label: e.label, medianGrade: null, supportAbove: 0, oppositionBelow: 0 };
    }
    // Find weighted median: cumulate from highest grade downward.
    let cum = 0;
    let medianGrade = min;
    for (let i = e.powerDist.length - 1; i >= 0; i--) {
      cum += e.powerDist[i];
      if (cum >= total / 2) {
        medianGrade = min + i;
        break;
      }
    }
    // Support above median: share of power at grades strictly above.
    let above = 0;
    for (let i = medianGrade - min + 1; i < e.powerDist.length; i++) {
      above += e.powerDist[i];
    }
    // Opposition below median: share of power at grades strictly below.
    let below = 0;
    for (let i = 0; i < medianGrade - min; i++) {
      below += e.powerDist[i];
    }
    return {
      id: e.id,
      label: e.label,
      medianGrade,
      supportAbove: total > 0 ? above / total : 0,
      oppositionBelow: total > 0 ? below / total : 0,
    };
  });

  // Sort: highest median first → highest supportAbove → lowest oppositionBelow.
  ranked.sort((a, b) => {
    if ((b.medianGrade ?? -Infinity) !== (a.medianGrade ?? -Infinity))
      return (b.medianGrade ?? -Infinity) - (a.medianGrade ?? -Infinity);
    if (b.supportAbove !== a.supportAbove)
      return b.supportAbove - a.supportAbove;
    if (a.oppositionBelow !== b.oppositionBelow)
      return a.oppositionBelow - b.oppositionBelow;
    return 0;
  });

  // Flag ties: entries that share the same (median, supportAbove,
  // oppositionBelow) after sorting are marked tied. The voting
  // authority resolves manually.
  for (let i = 0; i < ranked.length; i++) {
    const cur = ranked[i];
    const prev = i > 0 ? ranked[i - 1] : null;
    const next = i < ranked.length - 1 ? ranked[i + 1] : null;
    const tiedWithPrev =
      prev &&
      prev.medianGrade === cur.medianGrade &&
      Math.abs(prev.supportAbove - cur.supportAbove) < 1e-12 &&
      Math.abs(prev.oppositionBelow - cur.oppositionBelow) < 1e-12;
    const tiedWithNext =
      next &&
      next.medianGrade === cur.medianGrade &&
      Math.abs(next.supportAbove - cur.supportAbove) < 1e-12 &&
      Math.abs(next.oppositionBelow - cur.oppositionBelow) < 1e-12;
    cur.tied = !!(tiedWithPrev || tiedWithNext);
  }

  return ranked;
}

/**
 * Compute likert stats for one voter group's votes on one proposal.
 *
 * Vote rows carry Hydra v2 unified SelectionEntry[] — `{option, value}`
 * where value is the rating on the ratingRange grid.
 *
 * @param {Object} args
 * @param {Object} args.proposal - needs voteOptions, ratingRange
 * @param {Array<{userId, vote: Array<{option, value}>}>} args.votes - non-abstain votes for this group
 * @param {Map<string, {voterGroup, votingPower}>} args.votersByUserId
 * @param {boolean} args.voteWeighted
 * @returns {object|null}
 */
export function computeLikertStats({ proposal, votes, votersByUserId, voteWeighted }) {
  const range = proposal.ratingRange || { min: 1, max: 5 };
  const options = (proposal.voteOptions || []).filter((o) => o.id !== "abstain");
  if (options.length === 0) return null;

  const perOption = new Map();
  for (const o of options) {
    perOption.set(o.id, { values: [], samples: [] });
  }

  for (const v of votes) {
    const voter = votersByUserId?.get(v.userId);
    const power = voter?.votingPower ?? 1;
    const entries = Array.isArray(v.vote) ? v.vote : [];
    for (const r of entries) {
      if (r == null || typeof r !== "object") continue;
      const bucket = perOption.get(r.option);
      if (!bucket) continue;
      const rating = Number(r.value);
      if (!Number.isFinite(rating)) continue;
      bucket.values.push(rating);
      bucket.samples.push({ rating, power });
    }
  }

  const optionResults = options.map((o) => {
    const { values, samples } = perOption.get(o.id) || { values: [], samples: [] };
    const stats = descriptiveStats(values);
    const dist = buildDistribution(values, range.min, range.max);
    let weightedStats = null;
    let powerDist = null;
    let totalPower = 0;
    if (voteWeighted && samples.length > 0) {
      const pd = buildPowerDistribution(samples, range.min, range.max);
      powerDist = pd.powerDistribution;
      totalPower = pd.totalPower;
      // Weighted descriptive stats.
      const wSum = samples.reduce((s, x) => s + x.rating * x.power, 0);
      const wTotal = samples.reduce((s, x) => s + x.power, 0);
      const wMean = wTotal > 0 ? wSum / wTotal : 0;
      const wVar =
        wTotal > 0
          ? samples.reduce((s, x) => s + x.power * (x.rating - wMean) ** 2, 0) / wTotal
          : 0;
      weightedStats = {
        count: samples.length,
        mean: wMean,
        median: stats?.median ?? null,
        mode: stats?.mode ?? null,
        stdDev: Math.sqrt(wVar),
        powerDistribution: powerDist,
        totalPower,
      };
    }
    return {
      id: o.id,
      label: o.label,
      stats: stats ? { ...stats, distribution: dist } : { count: 0, distribution: dist },
      weightedStats,
      _powerDist: powerDist || buildPowerDistribution(samples, range.min, range.max).powerDistribution,
      _totalPower: totalPower || samples.reduce((s, x) => s + x.power, 0),
    };
  });

  // MJ ranking from power distributions.
  const mjEntries = optionResults.map((o) => ({
    id: o.id,
    label: o.label,
    powerDist: o._powerDist,
    totalPower: o._totalPower,
  }));
  const mj = majorityJudgment(mjEntries, range.min);

  // Strip internal fields from the response.
  const cleanOptions = optionResults.map(({ _powerDist, _totalPower, ...rest }) => rest);

  return {
    ratingRange: range,
    options: cleanOptions,
    majorityJudgment: mj,
  };
}

/**
 * Bucket raw likert votes by voter group.
 *
 * @param {Array} votes - { userId, vote: [{option, value}] | ["abstain"] }
 * @param {Map<string, {voterGroup, votingPower}>} votersByUserId
 * @returns {Map<string, Array<{userId, vote}>>}
 */
export function bucketLikertVotesByGroup(votes, votersByUserId) {
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
