import { computeLikertStats, bucketLikertVotesByGroup } from "../helper/results/likertStats.js";

const proposal = {
  ratingRange: { min: 1, max: 5 },
  voteOptions: [
    { id: 1, label: ">2500" },
    { id: 2, label: "2500" },
    { id: 3, label: "2000" },
  ],
};

const voters = new Map([
  ["a", { voterGroup: "drep", votingPower: 100 }],
  ["b", { voterGroup: "drep", votingPower: 200 }],
  ["c", { voterGroup: "drep", votingPower: 300 }],
  ["d", { voterGroup: "pool", votingPower: 5000 }],
]);

describe("likertStats.computeLikertStats", () => {
  test("returns null when no options", () => {
    expect(
      computeLikertStats({
        proposal: { ratingRange: { min: 1, max: 5 }, voteOptions: [] },
        votes: [],
        votersByUserId: new Map(),
        voteWeighted: false,
      })
    ).toBeNull();
  });

  test("computes per-option stats and distribution", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 5 }, { option: 2, value: 3 }, { option: 3, value: 1 }] },
      { userId: "b", vote: [{ option: 1, value: 4 }, { option: 2, value: 4 }, { option: 3, value: 2 }] },
      { userId: "c", vote: [{ option: 1, value: 5 }, { option: 2, value: 2 }, { option: 3, value: 3 }] },
    ];
    const r = computeLikertStats({ proposal, votes, votersByUserId: voters, voteWeighted: false });
    expect(r.ratingRange).toEqual({ min: 1, max: 5 });
    expect(r.options).toHaveLength(3);

    const opt1 = r.options.find((o) => o.id === 1);
    expect(opt1.stats.count).toBe(3);
    expect(opt1.stats.mean).toBeCloseTo((5 + 4 + 5) / 3);
    expect(opt1.stats.median).toBe(5);
    // distribution: [0, 0, 0, 1, 2] (grades 1-5; 0 at 1,2,3; 1 at 4; 2 at 5)
    expect(opt1.stats.distribution).toEqual([0, 0, 0, 1, 2]);

    const opt3 = r.options.find((o) => o.id === 3);
    expect(opt3.stats.count).toBe(3);
    expect(opt3.stats.distribution).toEqual([1, 1, 1, 0, 0]);
  });

  test("weighted stats include powerDistribution", () => {
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 5 }, { option: 2, value: 1 }] },
      { userId: "b", vote: [{ option: 1, value: 3 }, { option: 2, value: 5 }] },
    ];
    const r = computeLikertStats({ proposal, votes, votersByUserId: voters, voteWeighted: true });
    const opt1 = r.options.find((o) => o.id === 1);
    expect(opt1.weightedStats).not.toBeNull();
    expect(opt1.weightedStats.powerDistribution).toHaveLength(5);
    // a(power=100) rated 5, b(power=200) rated 3
    expect(opt1.weightedStats.powerDistribution[4]).toBe(100); // grade 5
    expect(opt1.weightedStats.powerDistribution[2]).toBe(200); // grade 3
    expect(opt1.weightedStats.totalPower).toBe(300);
  });

  test("MJ ranking sorts by weighted median", () => {
    // Option 1: two voters rate 5 (100+300 power), one rates 4 (200)
    // Option 2: one rates 5 (100), one rates 4 (200), one rates 2 (300)
    // Option 3: all rate 1 (100+200+300)
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 5 }, { option: 2, value: 5 }, { option: 3, value: 1 }] },
      { userId: "b", vote: [{ option: 1, value: 4 }, { option: 2, value: 4 }, { option: 3, value: 1 }] },
      { userId: "c", vote: [{ option: 1, value: 5 }, { option: 2, value: 2 }, { option: 3, value: 1 }] },
    ];
    const r = computeLikertStats({ proposal, votes, votersByUserId: voters, voteWeighted: true });
    expect(r.majorityJudgment).toHaveLength(3);
    // Option 1 should win: power at 5 = 400, at 4 = 200 → total 600.
    //   Cumulate from 5: 400 < 300 (50% of 600)? No, 400 >= 300. Median = 5.
    expect(r.majorityJudgment[0].id).toBe(1);
    expect(r.majorityJudgment[0].medianGrade).toBe(5);
    // Option 3 should lose: all power at grade 1 → median = 1.
    expect(r.majorityJudgment[2].id).toBe(3);
    expect(r.majorityJudgment[2].medianGrade).toBe(1);
  });

  test("MJ flags ties when median + above/below match", () => {
    // All three options get the same ratings from the same voters →
    // identical medians, identical above/below. Should be tied.
    const votes = [
      { userId: "a", vote: [{ option: 1, value: 3 }, { option: 2, value: 3 }, { option: 3, value: 3 }] },
      { userId: "b", vote: [{ option: 1, value: 3 }, { option: 2, value: 3 }, { option: 3, value: 3 }] },
    ];
    const r = computeLikertStats({ proposal, votes, votersByUserId: voters, voteWeighted: true });
    expect(r.majorityJudgment.every((e) => e.tied)).toBe(true);
    expect(r.majorityJudgment.every((e) => e.medianGrade === 3)).toBe(true);
  });
});

describe("likertStats.bucketLikertVotesByGroup", () => {
  test("groups by voterGroup, drops abstain", () => {
    const m = bucketLikertVotesByGroup(
      [
        { userId: "a", vote: [{ option: 1, value: 3 }] },
        { userId: "d", vote: ["abstain"] },
      ],
      voters
    );
    expect(m.get("drep")).toHaveLength(1);
    expect(m.get("pool")).toBeUndefined();
  });
});
