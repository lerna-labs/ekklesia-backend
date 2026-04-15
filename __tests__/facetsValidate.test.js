import {
  validateFacets,
  splitCsv,
  validateProposalFacetValues,
} from "../helper/facets/validate.js";

describe("facets.validateFacets", () => {
  test("accepts a well-formed set", () => {
    const r = validateFacets([
      {
        key: "category",
        label: "Category",
        type: "enum",
        multi: true,
        options: ["education", "infrastructure"],
        sortable: false,
        filterable: true,
      },
      {
        key: "totalCost",
        label: "Total cost",
        type: "number",
        sortable: true,
        filterable: true,
        unit: "ADA",
        defaultSort: "desc",
      },
    ]);
    expect(r).toEqual({ ok: true, errors: [] });
  });

  test("rejects comma inside enum option", () => {
    const r = validateFacets([
      {
        key: "category",
        label: "Category",
        type: "enum",
        options: ["a", "b,c"],
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /comma/.test(e.message))).toBe(true);
  });

  test("rejects multi + sortable combo", () => {
    const r = validateFacets([
      {
        key: "region",
        label: "Region",
        type: "enum",
        multi: true,
        sortable: true,
        options: ["x", "y"],
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.endsWith("sortable"))).toBe(true);
  });

  test("rejects multiple defaultSort declarations", () => {
    const r = validateFacets([
      { key: "a", label: "A", type: "number", sortable: true, defaultSort: "asc" },
      { key: "b", label: "B", type: "number", sortable: true, defaultSort: "desc" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === "facets")).toBe(true);
  });

  test("rejects duplicate keys", () => {
    const r = validateFacets([
      { key: "x", label: "X", type: "string" },
      { key: "x", label: "X2", type: "string" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /duplicate/.test(e.message))).toBe(true);
  });

  test("requires options[] for enum type", () => {
    const r = validateFacets([{ key: "c", label: "C", type: "enum" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.endsWith("options"))).toBe(true);
  });

  test("defaultSort requires sortable:true", () => {
    const r = validateFacets([
      { key: "c", label: "C", type: "number", defaultSort: "asc" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("facets.splitCsv", () => {
  test("single value, no trailing comma", () => {
    expect(splitCsv("education")).toEqual(["education"]);
  });
  test("csv with whitespace + dupes", () => {
    expect(splitCsv("education, infrastructure ,education,")).toEqual([
      "education",
      "infrastructure",
    ]);
  });
  test("empty and null", () => {
    expect(splitCsv("")).toEqual([]);
    expect(splitCsv(null)).toEqual([]);
  });
  test("numbers stringified pass through unchanged", () => {
    expect(splitCsv(42)).toEqual(["42"]);
  });
});

describe("facets.validateProposalFacetValues", () => {
  const defs = [
    { key: "category", type: "enum", multi: true, options: ["a", "b"] },
    { key: "region", type: "enum", multi: false, options: ["x", "y"] },
    { key: "cost", type: "number" },
  ];

  test("valid CSV on multi enum", () => {
    const r = validateProposalFacetValues({ category: "a,b" }, defs);
    expect(r.ok).toBe(true);
  });

  test("single-value enum rejects csv", () => {
    const r = validateProposalFacetValues({ region: "x,y" }, defs);
    expect(r.ok).toBe(false);
  });

  test("enum value outside options", () => {
    const r = validateProposalFacetValues({ category: "a,c" }, defs);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe("facets.category");
  });

  test("number type coercion not allowed", () => {
    const r = validateProposalFacetValues({ cost: "100" }, defs);
    expect(r.ok).toBe(false);
  });

  test("unknown facet key rejected", () => {
    const r = validateProposalFacetValues({ bogus: "z" }, defs);
    expect(r.ok).toBe(false);
  });

  test("absent value treated as fine", () => {
    expect(validateProposalFacetValues({}, defs).ok).toBe(true);
    expect(validateProposalFacetValues({ category: "" }, defs).ok).toBe(true);
    expect(validateProposalFacetValues({ region: null }, defs).ok).toBe(true);
  });
});
