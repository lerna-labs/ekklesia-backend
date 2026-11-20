---
"ekklesia-backend": minor
---

Closed legacy ballots keep their stored results: the provisional tally now skips them unless forced, and `recomputeAllResults.js` takes a `--force` flag. Ballots can carry an optional `voteThreshold` (a fraction from 0 to 1). When a legacy ballot has one, `GET /api/v1/proposals/ballot/:ballotId` and `GET /api/v1/proposals/:proposalId` return `thresholdReached` for each proposal, and the list endpoint accepts a `thresholdReached` filter.
