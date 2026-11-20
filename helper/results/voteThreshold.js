// Pass-threshold decision for legacy ballots that declare a `voteThreshold`.

/**
 * True when the ballot is legacy (a missing source counts as legacy) and carries a numeric threshold.
 */
export function ballotHasThreshold(ballot) {
  if (!ballot) return false;
  const source = ballot.source ?? 'legacy';
  return source === 'legacy' && typeof ballot.voteThreshold === 'number';
}

/**
 * True only when yes / (yes + no) is strictly greater than the ballot's threshold.
 * Abstain and other options are excluded; false when there is no Result or no yes/no votes.
 */
export function computeThresholdReached(result, ballot) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const field = ballot.voteWeighted === true ? 'votingPower' : 'count';
  let yes = 0;
  let no = 0;
  for (const row of rows) {
    const id = Number(row.id);
    const value = Number(row[field]) || 0;
    if (id === 1) yes += value;
    else if (id === -1) no += value;
  }
  if (!(yes + no > 0)) return false;
  return yes / (yes + no) > ballot.voteThreshold;
}
