import { computeWeightedStats, bucketWeightedVotesByGroup } from "../helper/results/weightedStats.js";

const proposal = {
  voterBudget: 100,
  voteOptions: [
    { id: 1, label: "Protocol" },
    { id: 2, label: "Ecosystem" },
    { id: 3, label: "Ops" },
  ],
};

const voters = new Map([
  ["a", { voterGroup: "drep", votingPower: 100 }],
  ["b", { voterGroup: "drep", votingPower: 200 }],
  ["c", { voterGroup: "pool", votingPower: 500 }],
]);

describe("weightedStats.computeWeightedStats", () => {
  test("returns null when proposal has no options", () => {
    expect(
      computeWeightedStats({
        proposal: { voterBudget: 100, voteOptions: [] },
        votes: [],
        votersByUserId: new Map(),
        voteWeighted: false,
      })
    ).toBeNull();
  });

  test("sums points per option, computes mean + stdDev", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 50 }, { option: 2, value: 30 }, { option: 3, value: 20 }] },
      { userId: "b", vote: [{ option: 1, value: 40 }, { option: 2, value: 40 }, { option: 3, value: 20 }] },
    ];
    const r = computeWeightedStats({ proposal, votes, votersByUserId: voters, voteWeighted: false });
    expect(r.budget).toBe(100);
    expect(r.voterCount).toBe(2);
    const o1 = r.results.find((x) => x.option === 1);
    expect(o1.totalPoints).toBe(90);
    expect(o1.voterCount).toBe(2);
    expect(o1.mean).toBe(45);
    expect(o1.stdDev).toBeCloseTo(5);
  });

  test("drops zero-value entries from voterCount but keeps totalPoints intact", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 100 }, { option: 2, value: 0 }, { option: 3, value: 0 }] },
      { userId: "b", vote: [{ option: 1, value: 0 }, { option: 2, value: 100 }, { option: 3, value: 0 }] },
    ];
    const r = computeWeightedStats({ proposal, votes, votersByUserId: voters, voteWeighted: false });
    const o1 = r.results.find((x) => x.option === 1);
    const o3 = r.results.find((x) => x.option === 3);
    expect(o1.totalPoints).toBe(100);
    expect(o1.voterCount).toBe(1); // only voter a contributed nonzero
    expect(o3.totalPoints).toBe(0);
    expect(o3.voterCount).toBe(0);
  });

  test("voteWeighted attaches powerTotalPoints scaled by voter power", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 50 }] }, // power 100 → contrib 5000
      { userId: "b", vote: [{ option: 1, value: 50 }] }, // power 200 → contrib 10000
    ];
    const r = computeWeightedStats({ proposal, votes, votersByUserId: voters, voteWeighted: true });
    const o1 = r.results.find((x) => x.option === 1);
    expect(o1.powerTotalPoints).toBe(15000);
  });

  test("ignores malformed entries (non-object, negative, NaN)", () => {
    const votes = [
      {
        userId: "a",
        vote: [
          { option: 1, value: 50 },
          { option: 2, value: -5 },     // rejected
          null,                          // rejected
          { option: 3, value: Number.NaN }, // rejected
        ],
      },
    ];
    const r = computeWeightedStats({ proposal, votes, votersByUserId: voters, voteWeighted: false });
    const o1 = r.results.find((x) => x.option === 1);
    const o2 = r.results.find((x) => x.option === 2);
    expect(o1.totalPoints).toBe(50);
    expect(o2.totalPoints).toBe(0);
  });
});

describe("weightedStats.bucketWeightedVotesByGroup", () => {
  test("groups votes by voterGroup, drops abstain", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 100 }] },
      { userId: "b", vote: [{ option: 2, value: 100 }] },
      { userId: "c", vote: ["abstain"] },
    ];
    const m = bucketWeightedVotesByGroup(votes, voters);
    expect(m.get("drep")).toHaveLength(2);
    expect(m.get("pool")).toBeUndefined();
  });
});
