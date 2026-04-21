// Per-group scale aggregation per .claude/trds/BACKEND_RESULTS_AGGREGATION.md.
//
// Returns the `scale` sub-object the frontend renders for histogram +
// descriptive stats. Computes both unweighted (count) and weighted
// (voting power) variants when the ballot is voteWeighted.
//
// Bucket strategy: 20 fixed buckets across [min, max] for every group.
// Easier to compare across groups than √n.
//
// Votes on this platform are public record (every vote is on-chain via
// the Hydra voting head), so there is no privacy threshold — histograms
// render for every participating group regardless of size.

const BUCKET_COUNT = 20;

function quantile(sortedNumbers, q) {
  if (sortedNumbers.length === 0) return null;
  if (sortedNumbers.length === 1) return sortedNumbers[0];
  const pos = (sortedNumbers.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedNumbers[base + 1] !== undefined) {
    return sortedNumbers[base] + rest * (sortedNumbers[base + 1] - sortedNumbers[base]);
  }
  return sortedNumbers[base];
}

function mode(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  if (max === 1) return null; // every value unique → no meaningful mode
  const winners = [];
  for (const [v, c] of counts.entries()) if (c === max) winners.push(v);
  winners.sort((a, b) => a - b);
  return winners.length === 1 ? winners[0] : winners;
}

function unweightedStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / sorted.length;
  const variance =
    sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    mean,
    median: quantile(sorted, 0.5),
    mode: mode(sorted),
    stdDev: Math.sqrt(variance),
    iqr: [quantile(sorted, 0.25), quantile(sorted, 0.75)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Power-weighted descriptive stats. We expand each value by its
 * voting-power weight at the algorithm level only — values themselves
 * stay distinct (no actual array expansion) because powers can be
 * billions. Quantiles are computed via cumulative-weight scan.
 */
function weightedStats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((s, x) => s + x.weight, 0);
  if (totalWeight === 0) return null;

  const weightedSum = sorted.reduce((s, x) => s + x.value * x.weight, 0);
  const mean = weightedSum / totalWeight;
  const variance =
    sorted.reduce((s, x) => s + x.weight * (x.value - mean) ** 2, 0) / totalWeight;

  function weightedQuantile(q) {
    let cum = 0;
    const target = q * totalWeight;
    for (const s of sorted) {
      cum += s.weight;
      if (cum >= target) return s.value;
    }
    return sorted[sorted.length - 1].value;
  }

  return {
    count: samples.length,
    mean,
    median: weightedQuantile(0.5),
    mode: mode(sorted.map((s) => s.value)), // mode is count-mode regardless
    stdDev: Math.sqrt(variance),
    iqr: [weightedQuantile(0.25), weightedQuantile(0.75)],
    min: sorted[0].value,
    max: sorted[sorted.length - 1].value,
  };
}

function buildHistogram(samples, min, max) {
  if (samples.length === 0) return [];
  const buckets = [];
  const span = max - min;
  if (span <= 0) return [];
  const width = span / BUCKET_COUNT;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    buckets.push({
      bucketMin: min + i * width,
      bucketMax: min + (i + 1) * width,
      count: 0,
      power: 0,
    });
  }
  for (const s of samples) {
    let idx = Math.floor((s.value - min) / width);
    if (idx >= BUCKET_COUNT) idx = BUCKET_COUNT - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count += 1;
    buckets[idx].power += s.weight;
  }
  return buckets;
}

/**
 * Build the `scale` sub-object for one voter group.
 *
 * @param {Object} args
 * @param {Object} args.proposal - needs voteOptions (numeric ids = scale anchors), voteIncrement
 * @param {Array<{value: number, weight: number}>} args.samples - non-abstain numeric votes for this group
 * @param {boolean} args.voteWeighted - whether to populate weightedStats
 * @returns {object|null}
 */
export function computeScaleStats({ proposal, samples, voteWeighted }) {
  if (!Array.isArray(samples) || samples.length === 0) return null;

  // Range derived from voteOptions ids (the scale's declared anchors).
  const numericIds = (proposal.voteOptions || [])
    .map((o) => Number(o.id))
    .filter((n) => Number.isFinite(n));
  if (numericIds.length === 0) return null;
  const min = Math.min(...numericIds);
  const max = Math.max(...numericIds);
  const increment = Number(proposal.voteIncrement) || 1;

  const values = samples.map((s) => s.value);
  return {
    min,
    max,
    increment,
    stats: unweightedStats(values),
    weightedStats: voteWeighted ? weightedStats(samples) : null,
    histogram: buildHistogram(samples, min, max),
  };
}

/**
 * Convenience: turn raw vote rows into per-group scale samples.
 *
 * @param {Array} votes - each { userId, vote: [<numeric or "abstain">] }
 * @param {Map<string, {voterGroup, votingPower}>} votersByUserId
 * @returns {Map<string, Array<{value, weight}>>}
 */
export function bucketScaleSamplesByGroup(votes, votersByUserId) {
  const out = new Map();
  for (const v of votes) {
    const voter = votersByUserId.get(v.userId);
    if (!voter) continue;
    const raw = Array.isArray(v.vote) ? v.vote[0] : v.vote;
    if (raw === "abstain" || raw == null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    const group = voter.voterGroup || "stake";
    if (!out.has(group)) out.set(group, []);
    out.get(group).push({ value: num, weight: voter.votingPower ?? 1 });
  }
  return out;
}
