import { buildFacetQuery, FacetQueryError } from "../helper/facets/queryAdapter.js";

const ballot = {
  facets: [
    {
      key: "category",
      type: "enum",
      multi: true,
      options: ["education", "infrastructure", "health"],
      sortable: false,
      filterable: true,
    },
    {
      key: "region",
      type: "enum",
      multi: false,
      options: ["LATAM", "EU", "APAC"],
      sortable: false,
      filterable: true,
    },
    {
      key: "totalCost",
      type: "number",
      sortable: true,
      filterable: true,
      defaultSort: "desc",
    },
    {
      key: "featured",
      type: "boolean",
      sortable: false,
      filterable: true,
    },
    {
      key: "hidden",
      type: "string",
      sortable: false,
      filterable: false,
    },
  ],
};

describe("buildFacetQuery — sort", () => {
  test("empty query falls back to createdAt desc when no defaultSort", () => {
    const r = buildFacetQuery({ facets: [] }, {});
    expect(r.sort).toEqual({ createdAt: -1 });
    expect(r.applied.sort.source).toBe("fallback");
  });

  test("uses defaultSort from facet when no explicit sort", () => {
    const r = buildFacetQuery(ballot, {});
    expect(r.sort).toEqual({ "externalProposal.snapshot.facets.totalCost": -1 });
    expect(r.applied.sort.key).toBe("totalCost");
    expect(r.applied.sort.source).toBe("default");
  });

  test("explicit sort overrides default", () => {
    const r = buildFacetQuery(ballot, { sort: "totalCost", dir: "asc" });
    expect(r.sort).toEqual({ "externalProposal.snapshot.facets.totalCost": 1 });
    expect(r.applied.sort.direction).toBe("asc");
  });

  test("rejects unknown sort key", () => {
    expect(() => buildFacetQuery(ballot, { sort: "ghost" })).toThrow(FacetQueryError);
  });

  test("rejects unsortable facet", () => {
    expect(() => buildFacetQuery(ballot, { sort: "category" })).toThrow(/not sortable/);
  });
});

describe("buildFacetQuery — filters", () => {
  test("multi enum single-value filter", () => {
    const r = buildFacetQuery(ballot, { filter: { category: "education" } });
    expect(JSON.stringify(r.filter)).toContain("externalProposal.snapshot.facets.category");
    expect(r.applied.filters.category).toEqual(["education"]);
  });

  test("multi enum CSV → OR of regex clauses", () => {
    const r = buildFacetQuery(ballot, {
      filter: { category: "education,health" },
    });
    // $or of two regex clauses
    expect(r.filter.$or).toBeDefined();
    expect(r.filter.$or).toHaveLength(2);
    expect(r.applied.filters.category).toEqual(["education", "health"]);
  });

  test("single-value enum CSV → $in", () => {
    const r = buildFacetQuery(ballot, { filter: { region: "LATAM,APAC" } });
    expect(r.filter["externalProposal.snapshot.facets.region"].$in).toEqual([
      "LATAM",
      "APAC",
    ]);
  });

  test("number filter coerces", () => {
    const r = buildFacetQuery(ballot, { filter: { totalCost: "500" } });
    expect(r.filter["externalProposal.snapshot.facets.totalCost"]).toBe(500);
  });

  test("number filter rejects non-number", () => {
    expect(() =>
      buildFacetQuery(ballot, { filter: { totalCost: "abc" } })
    ).toThrow(/finite number/);
  });

  test("boolean filter coerces", () => {
    const r = buildFacetQuery(ballot, { filter: { featured: "true" } });
    expect(r.filter["externalProposal.snapshot.facets.featured"]).toBe(true);
  });

  test("boolean rejects CSV of values", () => {
    expect(() =>
      buildFacetQuery(ballot, { filter: { featured: "true,false" } })
    ).toThrow(/multiple values/);
  });

  test("unknown filter key rejected", () => {
    expect(() =>
      buildFacetQuery(ballot, { filter: { bogus: "x" } })
    ).toThrow(/unknown filter key/);
  });

  test("non-filterable facet rejected", () => {
    expect(() =>
      buildFacetQuery(ballot, { filter: { hidden: "x" } })
    ).toThrow(/not filterable/);
  });

  test("filter value outside enum options rejected", () => {
    expect(() =>
      buildFacetQuery(ballot, { filter: { category: "education,rocketry" } })
    ).toThrow(/unknown options/);
  });

  test("two filters combined via $and", () => {
    const r = buildFacetQuery(ballot, {
      filter: { category: "education", region: "LATAM" },
    });
    expect(r.filter.$and).toHaveLength(2);
  });

  test("empty CSV ignored", () => {
    const r = buildFacetQuery(ballot, { filter: { category: "" } });
    expect(r.filter).toEqual({});
  });
});
