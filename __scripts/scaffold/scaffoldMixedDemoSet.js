// Seed a realistic mixed-source demo set: legacy archive rows + Hydra
// ballots across upcoming/live/closed states, spanning every combination
// of eligible voter groups, and with simulated votes + rollup results
// populated for closed and live ballots.
//
// Legacy ballots are ONLY scaffolded as closed (archive) — new writes
// to legacy are frozen in this codebase, so upcoming/live legacy rows
// would be pure noise.
//
// Hydra "closed" ballots in this scaffold are SIMULATED: they never
// touched the chain, but carry deterministic fake policy IDs, CIDs,
// head IDs, and asset names so the UI renders them identically to real
// archived Hydra ballots. Live/upcoming Hydra ballots can optionally
// /prepare against a real Hydra endpoint.
//
// Idempotent at the Ballot/Proposal/Vote/Result/UserCache level. Re-runs
// converge deterministically — same votes, same tallies.
//
// Usage:
//   node __scripts/scaffold/scaffoldMixedDemoSet.js
//   node __scripts/scaffold/scaffoldMixedDemoSet.js --endpoint https://hydra.preprod.example
//   node __scripts/scaffold/scaffoldMixedDemoSet.js --skip-hydra
//   node __scripts/scaffold/scaffoldMixedDemoSet.js --skip-votes

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import {
  upsertScaffoldBallot,
  VALIDATION_SCRIPTS,
} from "./common/ballotFactory.js";
import { buildPrepareBody } from "./common/hydraPrepare.js";
import { VOTERS } from "./common/fixtures.js";
import { SYNTHETIC_VOTERS } from "./common/syntheticVoters.js";
import { seedBallotVotes } from "./common/voteSeeder.js";
import { allocateBallotPower } from "./common/votingPowerDistribution.js";

// Combined demo cohort: real preprod voters (signing-capable, used for
// E2E) plus a synthetic cohort that exists only to give result tallies
// realistic distribution.
const ALL_VOTERS = [...VOTERS, ...SYNTHETIC_VOTERS];
import { User } from "../../schema/User.js";
import { UserCache } from "../../schema/UserCache.js";
import { Proposal } from "../../schema/Proposal.js";
import { Ballot } from "../../schema/Ballot.js";
import { Vote } from "../../schema/Vote.js";
import { Result } from "../../schema/Result.js";
import { VoterPowerSnapshot } from "../../schema/VoterPowerSnapshot.js";
import { forEndpoint, HydraClientError } from "../../helper/hydraClient.js";

const { flags } = parseArgs();

// ------------------------------------------------------------------
// Ballot plan
// ------------------------------------------------------------------
// Legacy — archive only. Each entry becomes one scaffolded closed ballot.
// Flavor set covers single-group and combined-group eligibility so the
// frontend can exercise every filter scenario against the archive.
const LEGACY_PLAN = [
  { flavor: "dreps", state: "closed", index: 1 },
  { flavor: "stake", state: "closed", index: 1 },
  { flavor: "poolStake", state: "closed", index: 1 },
  { flavor: "drepsPools", state: "closed", index: 1 },
  { flavor: "drepsStake", state: "closed", index: 1 },
  { flavor: "poolsStake", state: "closed", index: 1 },
  { flavor: "allGroups", state: "closed", index: 1 },
];

// Hydra — upcoming + live may hit a real Hydra endpoint; closed is
// always simulated (mint-policy timelock prevents scaffolding a real
// closed Hydra ballot from scratch).
const HYDRA_PLAN = [
  // Upcoming
  { flavor: "dreps", state: "upcoming", index: 1 },
  { flavor: "poolPledge", state: "upcoming", index: 1 },
  { flavor: "drepsPools", state: "upcoming", index: 1 },
  { flavor: "stake", state: "upcoming", index: 1 },
  { flavor: "allGroups", state: "upcoming", index: 1 },
  // Live
  { flavor: "dreps", state: "live", index: 1 },
  { flavor: "stake", state: "live", index: 1 },
  { flavor: "allGroups", state: "live", index: 1 },
  // Closed (simulated)
  { flavor: "dreps", state: "closed", index: 1, simulated: true },
  { flavor: "poolPledge", state: "closed", index: 1, simulated: true },
  { flavor: "drepsStake", state: "closed", index: 1, simulated: true },
  { flavor: "allGroups", state: "closed", index: 1, simulated: true },
];

await bootstrap();

const endpoint = flags.endpoint || process.env.HYDRA_DEFAULT_ENDPOINT;
const skipHydra = Boolean(flags["skip-hydra"]) || !endpoint;
const skipVotes = Boolean(flags["skip-votes"]);

// ------------------------------------------------------------------
// 0. Cleanup — remove stale scaffolded legacy upcoming/live rows.
//
// Older plan revisions allowed legacy ballots in live / upcoming
// states. The current policy is legacy = archive-only (closed). Anything
// from a previous run that still sits in upcoming/live gets removed
// here, along with its Proposals / Votes / Results / UserCache rows.
// Only scaffolded titles are touched — real legacy archive data is
// identified by prefix and left alone.
// ------------------------------------------------------------------
const staleFilter = {
  source: "legacy",
  status: { $in: ["upcoming", "live"] },
  title: { $regex: "^Scaffold/legacy/" },
};
const stale = await Ballot.find(staleFilter).select("_id title status").lean();
if (stale.length > 0) {
  const ids = stale.map((b) => b._id);
  await Promise.all([
    Vote.deleteMany({ ballotId: { $in: ids } }),
    Result.deleteMany({ ballotId: { $in: ids } }),
    UserCache.deleteMany({ ballotId: { $in: ids } }),
    Proposal.deleteMany({ ballotId: { $in: ids } }),
  ]);
  await Ballot.deleteMany({ _id: { $in: ids } });
  for (const b of stale) {
    console.log(`[mixed] cleanup removed stale legacy ${b.status} ballot: ${b.title}`);
  }
} else {
  console.log("[mixed] cleanup: no stale legacy upcoming/live ballots");
}

// ------------------------------------------------------------------
// 1. Voter profiles (real preprod + synthetic demo cohort)
// ------------------------------------------------------------------
for (const v of ALL_VOTERS) {
  await User.updateOne(
    { _id: v.userId },
    { $set: { name: v.name, lastLogin: new Date() } },
    { upsert: true }
  );
}
console.log(
  `[mixed] seeded ${ALL_VOTERS.length} user profiles (${VOTERS.length} real preprod + ${SYNTHETIC_VOTERS.length} synthetic)`
);

// ------------------------------------------------------------------
// 2. Legacy archive ballots
// ------------------------------------------------------------------
const legacyBallots = [];
for (const spec of LEGACY_PLAN) {
  const b = await upsertScaffoldBallot({ source: "legacy", ...spec });
  legacyBallots.push({ ballot: b, spec });
  console.log(
    `[mixed] legacy  ${b.title} (${b._id}) — ${VALIDATION_SCRIPTS[spec.flavor].voterType}`
  );
}

// ------------------------------------------------------------------
// 3. Hydra ballots (upsert docs; /prepare for non-simulated upcoming/live)
// ------------------------------------------------------------------
const hydraBallots = [];
for (const spec of HYDRA_PLAN) {
  const b = await upsertScaffoldBallot({
    source: "hydra",
    ...spec,
    provisionalResultsEnabled: true,
  });
  hydraBallots.push({ ballot: b, spec });

  const label = `[mixed] hydra   ${b.title} (${b._id}) — ${VALIDATION_SCRIPTS[spec.flavor].voterType}`;

  if (spec.simulated) {
    console.log(`${label} — SIMULATED (no /prepare; fake on-chain IDs)`);
    continue;
  }
  if (skipHydra) {
    console.log(`${label} — SKIPPED /prepare (${endpoint ? "--skip-hydra" : "no endpoint"})`);
    continue;
  }
  if (b.hydraEndpoint && !String(b.hydraEndpoint).startsWith("https://simulated.")) {
    console.log(`${label} — already prepared at ${b.hydraEndpoint}`);
    continue;
  }

  try {
    const client = forEndpoint(endpoint);
    const body = await buildPrepareBody(b);
    const data = await client.prepare(body);
    b.hydraEndpoint = endpoint;
    if (data?.ballotCid || data?.ballotIpfsCid)
      b.ballotCid = data.ballotCid || data.ballotIpfsCid;
    if (data?.instancePolicyId || data?.policyId)
      b.instancePolicyId = data.instancePolicyId || data.policyId;
    if (data?.hydraHeadId) b.hydraHeadId = data.hydraHeadId;
    await b.save();
    console.log(`${label} — prepared (namespace=${body.namespace})`);
  } catch (err) {
    const msg = err instanceof HydraClientError ? err.message : err.stack || err.message;
    console.warn(`${label} — /prepare FAILED: ${msg}`);
  }
}

// ------------------------------------------------------------------
// 4. UserCache — per ballot:
//    - validate voters whose group ∈ flavor.eligibleGroups
//    - allocate per-ballot voting power (lovelace) from a power-law
//      distribution summing to ~40-60% of 45B ADA
//    - non-eligible voters still get a UserCache row (validated:false,
//      votingPower:0) so the frontend has a complete picture
// ------------------------------------------------------------------
const allBallots = [...legacyBallots, ...hydraBallots];
let cacheRows = 0;
let bnToNum = (b) => {
  // votingPower is a Number in the schema. JS Number safely represents
  // integers up to 2^53 — fine for any individual lovelace allocation
  // here (whale shares stay well under 9e15). Per-ballot SUMs can
  // approach the limit; the few-lovelace rounding is invisible at demo
  // scale.
  return Number(b);
};

for (const { ballot, spec } of allBallots) {
  const eligibleGroups = new Set(VALIDATION_SCRIPTS[spec.flavor].eligibleGroups);
  const eligibleVoters = ALL_VOTERS.filter((v) => eligibleGroups.has(v.voterGroup));
  const allocations = allocateBallotPower(ballot._id.toString(), eligibleVoters);

  for (const v of ALL_VOTERS) {
    const isEligible = eligibleGroups.has(v.voterGroup);
    const power = isEligible ? bnToNum(allocations.get(v.userId) ?? 0n) : 0;
    await UserCache.updateOne(
      { ballotId: ballot._id, userId: v.userId },
      {
        $set: {
          validated: isEligible && v.validated,
          votingPower: power,
          voterGroup: v.voterGroup,
        },
      },
      { upsert: true }
    );
    cacheRows++;
  }
}
console.log(
  `[mixed] ${cacheRows} UserCache rows written across ${allBallots.length} ballots (per-ballot power allocation)`
);

// ------------------------------------------------------------------
// 4b. VoterPowerSnapshot — mirror the per-voter UserCache power into
//     the new snapshot collection so the v0/v1 reader returns the
//     same numbers without waiting on the 15min cron.
//
//     Skipped for ballots whose votingPowerSource has been set to
//     "uploaded" by an admin — those are authoritative; the scaffold
//     must not stomp them.
// ------------------------------------------------------------------
let snapshotRows = 0;
for (const { ballot, spec } of allBallots) {
  if (ballot.votingPowerSource?.type === "uploaded") {
    console.log(
      `[mixed] snapshot SKIP ${ballot.title} — source=uploaded (admin-authoritative)`
    );
    continue;
  }
  const eligibleGroups = new Set(VALIDATION_SCRIPTS[spec.flavor].eligibleGroups);
  const eligibleVoters = ALL_VOTERS.filter((v) => eligibleGroups.has(v.voterGroup));
  const allocations = allocateBallotPower(ballot._id.toString(), eligibleVoters);

  // Atomic replace: drop existing snapshot rows for this ballot, write
  // fresh ones from the same allocation we used for UserCache. Tag
  // source: "snapshot" + computedBy: "scaffold" so it's clear these
  // weren't produced by the cron.
  await VoterPowerSnapshot.deleteMany({ ballotId: ballot._id });
  const docs = eligibleVoters
    .map((v) => ({
      ballotId: ballot._id,
      userId: v.userId,
      voterGroup: v.voterGroup,
      votingPower: Number(allocations.get(v.userId) ?? 0n),
      source: "snapshot",
      computedAt: new Date(),
      computedBy: "scaffold:mixedDemoSet",
    }))
    .filter((d) => d.votingPower > 0);
  if (docs.length > 0) {
    await VoterPowerSnapshot.insertMany(docs, { ordered: true });
  }
  snapshotRows += docs.length;
}
console.log(`[mixed] ${snapshotRows} VoterPowerSnapshot rows written`);

// ------------------------------------------------------------------
// 5. Votes + results for closed and live ballots
// ------------------------------------------------------------------
if (skipVotes) {
  console.log(`[mixed] --skip-votes — no votes or results seeded`);
} else {
  let totalVotes = 0;
  for (const { ballot, spec } of allBallots) {
    if (spec.state === "upcoming") continue;
    const proposals = await Proposal.find({ ballotId: ballot._id }).lean();
    const eligibleGroups = new Set(VALIDATION_SCRIPTS[spec.flavor].eligibleGroups);
    // Look up each voter's per-ballot power from UserCache so the
    // rollup matches what /api endpoints will compute via $lookup.
    const cacheRows = await UserCache.find({ ballotId: ballot._id, validated: true })
      .select("userId votingPower voterGroup")
      .lean();
    // Re-stamp `forceParticipate` from the fixture list — UserCache
    // doesn't persist that flag, so without this cross-reference the
    // frontend voter-history test subject would roll the normal
    // participation dice and miss some ballots.
    const forcedIds = new Set(
      ALL_VOTERS.filter((v) => v.forceParticipate === true).map((v) => v.userId)
    );
    const eligibleVoters = cacheRows.map((c) => ({
      userId: c.userId,
      voterGroup: c.voterGroup,
      votingPower: c.votingPower,
      forceParticipate: forcedIds.has(c.userId),
    }));

    const { totalVotes: n, proposalsSeeded } = await seedBallotVotes({
      ballot,
      proposals,
      voters: eligibleVoters,
      state: spec.state,
    });
    totalVotes += n;
    console.log(
      `[mixed] votes   ${ballot.title} — ${n} votes across ${proposalsSeeded} proposals (${spec.state}, eligible ${eligibleVoters.length})`
    );
  }
  console.log(`[mixed] seeded ${totalVotes} votes total`);
}

await teardown();
process.exit(0);
