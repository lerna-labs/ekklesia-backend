// Per-group rank-distribution aggregation per .claude/trds/BACKEND_RESULTS_AGGREGATION.md.
//
// Returns the `ranked` sub-object frontends render as a per-option
// stacked bar showing how often each option was placed at each rank
// position (plus an "unranked" bucket).
//
// Vote shape assumption: a ranked vote is an array of option IDs
// in rank order, e.g. [3, 1, 2] meaning option 3 first, option 1
// second, option 2 third. Options not appearing in the array are
// considered unranked by that voter.

/**
 * @param {Object} args
 * @param {Object} args.proposal - needs voteOptions [{id, label}]
 * @param {Array} args.votes     - { userId, vote: [<id>, <id>, ...] }
 * @param {Map<string, {voterGroup, votingPower}>} args.votersByUserId
 * @returns {Map<string, { rankDepth, rows: Array }>}
 *   keyed by voterGroup, omits groups with zero ranked votes.
 */
export function computeRankedDistribution({ proposal, votes, votersByUserId }) {
  const options = Array.isArray(proposal.voteOptions) ? proposal.voteOptions : [];
  const optionIds = options
    .map((o) => o.id)
    .filter((id) => id !== "abstain"); // abstain isn't ranked
  if (optionIds.length === 0) return new Map();

  // Rank depth = option count. Voters can rank fewer; we still allocate
  // counts[rankDepth] so the matrix is rectangular.
  const rankDepth = optionIds.length;

  // group → optionId → { counts: number[], power: number[],
  //                      unrankedCount, unrankedPower }
  const acc = new Map();
  function ensureGroup(group) {
    if (acc.has(group)) return acc.get(group);
    const perOption = new Map();
    for (const id of optionIds) {
      perOption.set(id, {
        counts: new Array(rankDepth).fill(0),
        power: new Array(rankDepth).fill(0),
        unrankedCount: 0,
        unrankedPower: 0,
      });
    }
    acc.set(group, perOption);
    return perOption;
  }

  for (const v of votes) {
    const voter = votersByUserId.get(v.userId);
    if (!voter) continue;
    const ranking = Array.isArray(v.vote) ? v.vote : [];
    // Skip abstain-only votes — they don't contribute to the rank picture.
    const usableRanking = ranking.filter((id) => id !== "abstain");
    if (usableRanking.length === 0) continue;

    const group = voter.voterGroup || "default";
    const power = voter.votingPower ?? 1;
    const perOption = ensureGroup(group);

    const ranked = new Set();
    usableRanking.forEach((id, idx) => {
      const row = perOption.get(id);
      if (!row) return; // unknown option id, skip
      if (idx >= rankDepth) return; // beyond rank depth — shouldn't happen
      row.counts[idx] += 1;
      row.power[idx] += power;
      ranked.add(id);
    });
    // Anything not in this voter's ranking → unranked bucket
    for (const id of optionIds) {
      if (!ranked.has(id)) {
        const row = perOption.get(id);
        row.unrankedCount += 1;
        row.unrankedPower += power;
      }
    }
  }

  const out = new Map();
  for (const [group, perOption] of acc.entries()) {
    const rows = options
      .filter((o) => o.id !== "abstain")
      .map((o) => {
        const data = perOption.get(o.id);
        return {
          id: o.id,
          label: o.label,
          counts: data.counts,
          power: data.power,
          unranked: { count: data.unrankedCount, power: data.unrankedPower },
        };
      });
    out.set(group, { rankDepth, rows });
  }
  return out;
}
