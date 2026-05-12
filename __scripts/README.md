# `__scripts/` — administrative and scaffolding utilities

Runnable from the repo root with `node __scripts/<name>.js`. All scripts read
`.env.${NODE_ENV}` (defaulting to `development`) before connecting to Mongo.

## Scaffolds (`__scripts/scaffold/`)

Idempotent where noted — re-runs converge on the same rows rather than
duplicating. Use these to produce reproducible data for local dev, UX demos,
and end-to-end integration runs.

| Script | Purpose | Idempotent | Hydra required |
|---|---|---|---|
| `scaffold/seedVoters.js` | Upserts the deterministic voter fixtures (`common/fixtures.js`) into `User`. Pass `--ballotId` to also write `UserCache` rows for a specific ballot. | yes | no |
| `scaffold/scaffoldLegacyBallot.js` | Upserts one legacy-shaped ballot. Deterministic title like `Scaffold/legacy/dreps/live#001`. | yes | no |
| `scaffold/scaffoldHydraBallot.js` | Upserts a Hydra-backed ballot *and* calls Hydra `/prepare` on first run. Re-runs skip `/prepare` unless `--force` is passed. | yes (doc) / no (L1 mint) | yes |
| `scaffold/scaffoldMixedDemoSet.js` | Seeds voters + 3 legacy + 2 Hydra ballots across upcoming/live/closed. Pass `--skip-hydra` or omit `--endpoint`/`HYDRA_DEFAULT_ENDPOINT` to stage only the DB side. | yes (doc) / no (L1 mint) | optional |

Common flags:

- `--flavor` — `dreps` (default), `stake`, `poolPledge`, `poolStake`, `alwaysTrue`.
- `--state` — `upcoming`, `live` (default), `closed`.
- `--index N` — disambiguator baked into the deterministic title (default `1`).
- `--endpoint URL` — override `HYDRA_DEFAULT_ENDPOINT` for scripts that call Hydra.
- `--force` — bypass the "already prepared" short-circuit on Hydra scaffolds.

### Typical flows

```bash
# Local-only legacy ballot for frontend dev
node __scripts/scaffold/scaffoldLegacyBallot.js --flavor dreps --state live

# Seed voters and pin them to one ballot
node __scripts/scaffold/seedVoters.js --ballotId 65f0deadbeef0000feedfacef

# Full mixed demo against a preprod Hydra. The API-key env-var name is
# derived from the endpoint URL — non-alphanumerics → "_", upper-cased.
HYDRA_DEFAULT_ENDPOINT=https://hydra.preprod.example \
HYDRA_API_KEY_HTTPS_HYDRA_PREPROD_EXAMPLE=… \
node __scripts/scaffold/scaffoldMixedDemoSet.js

# Same demo, Mongo-only (no Hydra)
node __scripts/scaffold/scaffoldMixedDemoSet.js --skip-hydra
```

## Lifecycle orchestration

Phase 3 E2E voting flow, end-to-end. Each script is usable on its own; the
top-level orchestrator stitches them together.

| Script | Purpose |
|---|---|
| `phase3E2E.js` | One-shot orchestrator: scaffold → wait → seed → /start → single-sig vote → multisig vote → stepped close. Flags: `--force`, `--ballotId`, `--flavor`, `--state`, `--skipVotes`, `--keepOpen`, `--closeToken`. |
| `lifecycle/startBallot.js` | Scaffold a ballot (or reuse via `--ballotId`), wait for the prepare tx on L1, then call `/start` on the backend admin route. Prints `export BALLOT='…'`. |
| `lifecycle/closeBallot.js` | Canonical stepped close: `/settle/burn` (looped until `remaining === 0`), `/settle/finalize`, `/settle/close`. Requires `--closeToken`. |
| `vote/castVote.js` | Single-sig voter end-to-end: mint JWT → `/draft` → `cardano-signer` COSE sign → `/signature`. |
| `vote/castVoteMultisig.js` | Multisig voter end-to-end: mint JWT → `/draft` with `nativeScript` → sign with N cosigners (defaults to `script.required`) → `/signature` per witness; backend aggregates + submits once threshold is met. |

## Utilities

| Script | Purpose | Destructive |
|---|---|---|
| `backfillBallotSource.js` | One-shot: stamps `source: "legacy"` on Ballot docs missing the field. Idempotent. | no |
| `waitForPrepareConfirmation.js` | Polls Koios `/tx_info` for the `/prepare` L1 tx stamped on a Ballot doc and blocks until it lands. Flags: `--ballotId` or `--txHash`, `--pollSec`, `--timeoutSec`. Exits 0 on confirmation, 1 on timeout. | no |
| `resetHydraBallot.js` | Wipes backend Mongo state for a ballot (VotePackages, Votes, UserCache nonces) and either clears Hydra fields (`--clear`) or deletes the Ballot + Proposals (`--delete`). Scoped: `--ballotId` / `--title` / `--all-hydra` / `--all` (bulk modes require `--confirm`). Pair with `sweepAdminWallet.js` + Hydra restart for a full end-to-end reset. | **yes — edits Mongo** |
| `sweepAdminWallet.js` | Calls Hydra `POST /sweep` to consolidate the admin wallet and offload residue tokens to `HYDRA_SWEEP_ADDRESS` (or `--dumpAddress`). Run between test runs or after a failed `/prepare`. Submits a real L1 tx. | no (but submits a tx) |
| `issueApiKey.js` | Mints a public-API key. Prints plaintext secret ONCE. | no |
| `mintDevJwt.js` | Dev-only: mints a JWT using `JWT_SECRET`. Dev workflow only. | no |
| `createTestBallot.js` | **Legacy** — original non-idempotent ballot factory. Prefer `scaffold/scaffoldLegacyBallot.js`. | no |
| `createTestBallotVoterGroups.js` | Legacy variant of the above. | no |
| `createIncentiveVote.js` | Legacy scaffold for the incentive-vote shape. | no |
| `wipeDB.js` | Drops every collection. Requires `--confirm` (dry-run otherwise). `--except sessions,faqs` preserves specific collections. **Destructive.** | **yes** |
| `comparePoolData/` | Offline comparison utility for stake-pool snapshots. | no |
| `faqs/importFAQs.js` | Upserts FAQ entries from `faqs/faqs.json`. | no |

## Conventions for new scaffolds

- Use `scaffold/common/env.js` for bootstrap + argv parsing. Call `bootstrap()` before touching Mongo and `teardown()` before exit.
- Use `scaffold/common/ballotFactory.js` for deterministic Ballot/Proposal creation. Extend `VALIDATION_SCRIPTS` and `defaultProposals` there rather than inlining new shapes.
- Pin fixtures in `scaffold/common/fixtures.js` — shared across all scaffolds and Phase-3 tests.
- Destructive scripts must require `--confirm` and print a 3-second banner before acting.
