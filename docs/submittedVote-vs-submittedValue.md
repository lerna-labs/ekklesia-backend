# submittedVote vs submittedValue Inconsistency

This document describes an inconsistency between `submittedVote` and `submittedValue` in the codebase, likely from earlier iterations, and where to change what.

## Summary

- **Canonical:** The Vote schema and most of the app use **`submittedVote`** (array of vote option IDs).
- **Wrong / legacy:** A few places still use **`submittedValue`**, which is **not** a field on the Vote model. Those code paths are either wrong or only work if something else is populating that field.

---

## 1. Schema (correct)

**`schema/Vote.js`**

- Defines **`submittedVote`** (array), not `submittedValue`.
- No changes needed here.

---

## 2. Routes – `routes/api/v0/proposals.js`

**Total vote count (lines 41–44):**

- Uses `submittedValue`. The Vote model has no such field.
- **Change to:** `submittedVote` with a condition that fits "has submitted" (e.g. `submittedVote: { $exists: true, $ne: null }`, and optionally exclude empty arrays if you use `[]` for "not submitted").

**User vote (lines 48–54):**

- Uses `userVote?.value`. The schema has `vote` and `submittedVote`, not `value`.
- **Change to:** e.g. `userVote?.submittedVote ?? userVote?.vote ?? null` (depending on whether you want to show last submitted or current choice; docstring says "vote option IDs" so `submittedVote` is the right source for "submitted" state).

**Results aggregation (lines 145–179):**

- Uses `$group: { _id: "$submittedValue", ... }`. Again, the field is `submittedVote`.
- **Change to:** group by the submitted vote. Because `submittedVote` is an array and the rest of the code (e.g. ballots) treats the first element as the option for single-option votes, use something like:
  - `_id: { $arrayElemAt: ["$submittedVote", 0] }`
  so that `result._id` matches `option.value` in the existing `resultsWithLabels` logic (line 194).

---

## 3. Helper – `helper/getVotes.js`

**Line 173:**

- `.select("ballotId submittedValue proposalId")`
- **Change to:** `.select("ballotId submittedVote proposalId")`.

**Line 204:**

- `... ).submittedValue`
- **Change to:** use `submittedVote`. Downstream code uses `proposal.vote` and compares to `voteOptions` by `value` (single value). So for single-option (e.g. scale) votes use the first element, e.g. `... ).submittedVote` and then set `proposal.vote` from that (e.g. `vote.submittedVote?.[0] ?? vote.submittedVote` or the same shape your API expects).

---

## 4. Rollup – `helper/rollupBallot.js`

**Lines 66, 80–88:**

- Explicitly supports **both** `submittedVote` and `submittedValue` (fallback and different handling for default vs other vote types).
- **Change to (if you want one name):** use only **`submittedVote`** for both branches (treat it as an array: first element or stringify as you do now). Then remove all `submittedValue` handling.
- **Alternative:** keep supporting both if this input can come from external/legacy data (e.g. test fixtures) that still use `submittedValue`.

---

## 5. Test data – `helper/__tests__/test_results.json`

- Vote objects use **`submittedValue`** (e.g. `1`, `0`, `-1`).
- This is **input to `rollupBallot`**, which currently accepts both names.
- **If** you standardize `rollupBallot` on **only** `submittedVote`, then either:
  - Rename in the fixture to `submittedVote` and use array form to match the schema (e.g. `[1]`, `[0]`, `[-1]`), or
  - Keep `rollupBallot` accepting `submittedValue` only for backward compatibility with this file and any similar input.

---

## 6. Other files (already consistent)

- **`routes/api/v0/ballots.js`**, **`routes/api/v0/voters.js`**, **`helper/calculateMedians.js`**, **`crons/10minAggregateVotes.js`**, **`routes/api/v0/dashboard.js`**, **`docs/openapi.yaml`**, **`schema/Vote.js`**
- These use **`submittedVote`** only; no change needed for this inconsistency.

---

## Recommended change list

| File | What to change |
|------|----------------|
| **`routes/api/v0/proposals.js`** | Use `submittedVote` in the count query; use `userVote?.submittedVote` (or `userVote?.vote`) instead of `userVote?.value`; in the results aggregation use `$submittedVote` and group by first element, e.g. `_id: { $arrayElemAt: ["$submittedVote", 0] }`. |
| **`helper/getVotes.js`** | Select `submittedVote` instead of `submittedValue`; read `submittedVote` and derive `proposal.vote` from it (e.g. first element for single-option). |
| **`helper/rollupBallot.js`** | Optionally drop `submittedValue` and use only `submittedVote` (with array handling); if you keep both for backward compatibility, no change. |
| **`helper/__tests__/test_results.json`** | Only if you stop supporting `submittedValue` in `rollupBallot`: rename to `submittedVote` and use array values. |

Fixing **proposals.js** and **getVotes.js** is necessary so they use the real schema field (`submittedVote`). The **rollupBallot** and test data changes are for consistency and optional depending on whether you need to support legacy `submittedValue` input.

---

## Implementation (completed)

The following changes were applied to align the codebase with the Vote schema (`submittedVote`).

### `routes/api/v0/proposals.js`

- **Total vote count:** `submittedValue` → `submittedVote` in `Vote.countDocuments()` match.
- **User vote:** `userVote?.value` → `userVote?.submittedVote ?? userVote?.vote ?? null` so the API uses the schema fields and falls back to current `vote` if needed.
- **Results aggregation:**
  - Added `submittedVote: { $exists: true, $ne: null }` to the initial `$match` so only submitted votes are counted.
  - `$group._id: "$submittedValue"` → `_id: { $arrayElemAt: ["$submittedVote", 0] }` so grouping uses the first option in the `submittedVote` array and still matches `option.value` in `resultsWithLabels`.

### `helper/getVotes.js`

- **Select:** `.select("ballotId submittedValue proposalId")` → `.select("ballotId submittedVote proposalId")`.
- **Reading vote:** Replaced direct `.submittedValue` with a lookup that uses `submittedVote`: `proposal.vote = vote?.submittedVote?.[0] ?? vote?.submittedVote ?? null` (first element for single-option, full array otherwise).
- **Safety:** `proposal.voteLabel` now uses optional chaining (`.find(...)?.label`) when resolving the label from `voteOptions`.

### `helper/rollupBallot.js`

- **Unified handling:** Introduced `const submitted = vote.submittedVote ?? vote.submittedValue` so the code prefers the schema field but still accepts legacy `submittedValue` (e.g. from `helper/__tests__/test_results.json`).
- **Validation:** Check changed from “both undefined” to “submitted is undefined or null”.
- **Vote value:** Both `default` and other vote types now derive `vote_value` from a single `submittedArr` (array or single value normalized to array), so behavior is consistent for either field name.

### Not changed

- **`helper/__tests__/test_results.json`:** Left as-is. It still uses `submittedValue`; `rollupBallot` accepts both, so the fixture continues to work without migration.
