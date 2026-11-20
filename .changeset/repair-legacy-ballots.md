---
"ekklesia-backend": minor
---

Added `__scripts/repairLegacyBallots.js`, a one-off script that repairs named legacy ballots created before the VoterCache to UserCache rename. It sets `source` and `status`, replaces the voter validation script with `voterValidationAlwaysFalse.js`, copies voting power from `votercaches` into `usercaches`, adds `userId` and `status` to comments that lack them, and force-retallies each proposal. It runs as a dry run unless given `--apply`.
