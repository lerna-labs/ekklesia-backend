/**
 * Project a voter's `submittedVote` array into the per-proposal `vote`
 * shape returned by `GET /api/v0/voters/:userId`.
 *
 * Shape per `voteType`:
 *   choice / multi-choice / ranked  → ["Label", ...]
 *   scale                           → [<number>]   (zero is preserved)
 *   likert / weighted               → [{ option, optionLabel, value }, ...]
 *   any abstain                     → ["Abstain"]  (sentinel "abstain" in submittedVote)
 *
 * Object-shaped entries (likert/weighted) carry `{ option, value }`; we
 * denormalize `optionLabel` from the proposal's `voteOptions` so the
 * frontend doesn't need a second lookup.
 *
 * @param {Array} submittedVote - raw `vote.submittedVote` array
 * @param {{ voteType: string, voteOptions: Array<{ id: any, label: string }> }} proposal
 * @returns {Array}
 */
export function projectVoteEntries(submittedVote, proposal) {
  if (!Array.isArray(submittedVote)) return [];
  const voteType = proposal?.voteType;
  const voteOptions = Array.isArray(proposal?.voteOptions) ? proposal.voteOptions : [];

  const findOption = (id) => voteOptions.find((o) => o?.id?.toString() === String(id));

  return submittedVote
    .map((entry) => {
      if (entry === 'abstain') return 'Abstain';

      if (entry && typeof entry === 'object' && entry.option != null) {
        const opt = findOption(entry.option);
        return {
          option: entry.option,
          optionLabel: opt?.label ?? String(entry.option),
          value: entry.value,
        };
      }

      if (voteType === 'scale') return entry;

      const opt = findOption(entry);
      return opt ? opt.label : null;
    })
    .filter((v) => v !== null && v !== undefined);
}
