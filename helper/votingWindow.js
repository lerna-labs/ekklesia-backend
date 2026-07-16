// Shared vote-write gate. Returns whether a ballot is currently
// accepting vote writes (drafts, signatures, submissions) based on
// votePeriodStart / votePeriodEnd. Strict: votePeriodStart <= now <
// votePeriodEnd. Independent of ballot.status, so the 1min cron race
// between votePeriodEnd elapsing and status flipping to "closed" does
// not leak a final-second write.
//
// Returned reasons:
//   "not-open"  — now < votePeriodStart (ballot hasn't opened yet)
//   "closed"    — now >= votePeriodEnd (voting period ended)

export const VOTE_WINDOW_CODES = Object.freeze({
  NOT_OPEN: 'VOTING_WINDOW_NOT_OPEN',
  CLOSED: 'VOTING_WINDOW_CLOSED',
});

/**
 * @param {{ votePeriodStart?: Date|string, votePeriodEnd?: Date|string }} ballot
 * @param {Date} [now]
 * @returns {{ ok: true } | { ok: false, reason: "not-open"|"closed", code: string, message: string }}
 */
export function checkVotingWindow(ballot, now = new Date()) {
  const start = ballot?.votePeriodStart ? new Date(ballot.votePeriodStart) : null;
  const end = ballot?.votePeriodEnd ? new Date(ballot.votePeriodEnd) : null;

  if (start && now < start) {
    return {
      ok: false,
      reason: 'not-open',
      code: VOTE_WINDOW_CODES.NOT_OPEN,
      message: 'Voting period has not opened yet',
    };
  }
  if (end && now >= end) {
    return {
      ok: false,
      reason: 'closed',
      code: VOTE_WINDOW_CODES.CLOSED,
      message: 'Voting period has ended',
    };
  }
  return { ok: true };
}
