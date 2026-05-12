import {
  computeScaleStats,
  bucketScaleSamplesByGroup,
} from "../helper/results/scaleStats.js";

const proposal = {
  voteOptions: [
    { id: -100, label: "-100" },
    { id: 0, label: "0" },
    { id: 100, label: "100" },
  ],
  voteIncrement: 1,
};

describe("scaleStats.computeScaleStats", () => {
  test("returns null on empty samples", () => {
    expect(computeScaleStats({ proposal, samples: [], voteWeighted: true })).toBeNull();
  });

  test("computes basic stats over a small sample", () => {
    const samples = [
      { value: -50, weight: 100 },
      { value: 0, weight: 200 },
      { value: 25, weight: 50 },
      { value: 50, weight: 150 },
      { value: 100, weight: 100 },
    ];
    const r = computeScaleStats({ proposal, samples, voteWeighted: true });
    expect(r.min).toBe(-100);
    expect(r.max).toBe(100);
    expect(r.increment).toBe(1);
    expect(r.stats.count).toBe(5);
    expect(r.stats.median).toBe(25);
    expect(r.stats.min).toBe(-50);
    expect(r.stats.max).toBe(100);
    expect(r.weightedStats).not.toBeNull();
    expect(r.weightedStats.count).toBe(5);
    expect(r.histogram).toHaveLength(20);
    const totalCount = r.histogram.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(5);
  });

  test("histogram renders for small groups (votes are public record)", () => {
    const samples = [
      { value: 10, weight: 1 },
      { value: 20, weight: 1 },
      { value: 30, weight: 1 },
    ];
    const r = computeScaleStats({ proposal, samples, voteWeighted: false });
    expect(Array.isArray(r.histogram)).toBe(true);
    expect(r.histogram).toHaveLength(20);
    const totalCount = r.histogram.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(3);
    expect(r.stats.count).toBe(3);
  });

  test("weightedStats omitted when voteWeighted false", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ value: i * 10, weight: 1 }));
    const r = computeScaleStats({ proposal, samples, voteWeighted: false });
    expect(r.weightedStats).toBeNull();
    expect(r.stats.count).toBe(10);
  });
});

describe("scaleStats.bucketScaleSamplesByGroup", () => {
  const voters = new Map([
    ["a", { voterGroup: "drep", votingPower: 100 }],
    ["b", { voterGroup: "drep", votingPower: 200 }],
    ["c", { voterGroup: "pool", votingPower: 5000 }],
  ]);

  test("groups by voterGroup, drops abstain", () => {
    const m = bucketScaleSamplesByGroup(
      [
        { userId: "a", vote: [10] },
        { userId: "b", vote: [-20] },
        { userId: "c", vote: ["abstain"] },
      ],
      voters
    );
    expect(m.get("drep")).toEqual([
      { value: 10, weight: 100 },
      { value: -20, weight: 200 },
    ]);
    expect(m.get("pool")).toBeUndefined();
  });

  test("ignores votes from unknown voters", () => {
    const m = bucketScaleSamplesByGroup(
      [{ userId: "z", vote: [50] }],
      voters
    );
    expect(m.size).toBe(0);
  });
});
