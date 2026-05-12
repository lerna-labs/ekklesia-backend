// Unit test for the snapshot reader's pure rollup helper. The
// DB-touching paths (readBallotPower / computeActive) are exercised
// indirectly by integration tests; this verifies the per-group rollup
// that the reader uses to translate per-voter rows into the response
// shape.
//
// Re-imports the scalarTotals + rollup logic via the public surface so
// future refactors of the internals don't break this test.

import { scalarTotals } from "../helper/votingPower/snapshotReader.js";

describe("snapshotReader.scalarTotals", () => {
  test("sums per-group object back to scalars", () => {
    const r = scalarTotals({
      totalVotingPower: { drep: 1000, pool: 5000, default: 250 },
      eligibleVoterCount: { drep: 2, pool: 1, default: 1 },
    });
    expect(r.totalVotingPower).toBe(6250);
    expect(r.totalAllowedVoterCount).toBe(4);
  });

  test("empty groups → zero scalars", () => {
    const r = scalarTotals({ totalVotingPower: {}, eligibleVoterCount: {} });
    expect(r.totalVotingPower).toBe(0);
    expect(r.totalAllowedVoterCount).toBe(0);
  });

  test("single-group object", () => {
    const r = scalarTotals({
      totalVotingPower: { drep: 12345 },
      eligibleVoterCount: { drep: 7 },
    });
    expect(r.totalVotingPower).toBe(12345);
    expect(r.totalAllowedVoterCount).toBe(7);
  });
});
