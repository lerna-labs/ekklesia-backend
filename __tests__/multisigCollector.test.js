import { status, thresholdMet, dedupeSignatures } from "../helper/multisigCollector.js";

const script2of3 = {
  type: "atLeast",
  required: 2,
  scripts: [
    { type: "sig", keyHash: "aa".repeat(28) },
    { type: "sig", keyHash: "bb".repeat(28) },
    { type: "sig", keyHash: "cc".repeat(28) },
  ],
};

const scriptAll = {
  type: "all",
  scripts: [
    { type: "sig", keyHash: "aa".repeat(28) },
    { type: "sig", keyHash: "bb".repeat(28) },
  ],
};

function sig(keyHash) {
  return {
    key: keyHash,
    coseSign1Hex: "deadbeef",
    coseKeyHex: "",
    signature: "",
  };
}

describe("multisigCollector.status", () => {
  test("reports unsatisfied with empty signatures", () => {
    const s = status(script2of3, []);
    expect(s.satisfied).toBe(false);
    expect(s.required).toBe(2);
    expect(s.outstandingKeys).toHaveLength(3);
  });

  test("satisfied once threshold is met on atLeast", () => {
    const s = status(script2of3, [sig("aa".repeat(28)), sig("bb".repeat(28))]);
    expect(s.satisfied).toBe(true);
    expect(s.outstandingKeys).toEqual(["cc".repeat(28)]);
  });

  test("all-type script needs every key", () => {
    const partial = status(scriptAll, [sig("aa".repeat(28))]);
    expect(partial.satisfied).toBe(false);
    const complete = status(scriptAll, [sig("aa".repeat(28)), sig("bb".repeat(28))]);
    expect(complete.satisfied).toBe(true);
  });

  test("case-insensitive key matching", () => {
    const s = status(script2of3, [sig("AA".repeat(28)), sig("BB".repeat(28))]);
    expect(s.satisfied).toBe(true);
  });
});

describe("multisigCollector.thresholdMet", () => {
  test("mirrors status().satisfied", () => {
    expect(thresholdMet(scriptAll, [])).toBe(false);
    expect(thresholdMet(scriptAll, [sig("aa".repeat(28)), sig("bb".repeat(28))])).toBe(true);
  });
});

describe("multisigCollector.dedupeSignatures", () => {
  test("collapses duplicate keys (later wins)", () => {
    const first = { key: "aa".repeat(28), signature: "v1" };
    const second = { key: "aa".repeat(28), signature: "v2" };
    const other = { key: "bb".repeat(28), signature: "other" };
    const result = dedupeSignatures([first, second, other]);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.key === "aa".repeat(28)).signature).toBe("v2");
  });

  test("silently drops entries with no key", () => {
    const result = dedupeSignatures([{ signature: "no-key" }, sig("aa".repeat(28))]);
    expect(result).toHaveLength(1);
  });
});
