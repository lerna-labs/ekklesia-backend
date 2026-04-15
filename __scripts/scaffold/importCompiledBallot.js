// Scaffold: import a sample CompiledBallot via the writer, exercising
// per-ballot facets end-to-end (budget-style: enum categories, numeric
// cost, multi-select region, boolean featured flag).
//
// Default mode calls helper/compiledBallot/writer.js directly — no
// running backend required. Pass --http to POST against
// /api/v1/admin/ballots/import on a live dev server instead (useful
// for end-to-end auth + rate-limit smoke).
//
// Usage:
//   node __scripts/scaffold/importCompiledBallot.js
//   node __scripts/scaffold/importCompiledBallot.js --http \
//        --url http://localhost:3000 --apiKey <key>

import process from "process";
import { bootstrap, teardown, parseArgs } from "./common/env.js";
import { validateCompiledBallot } from "../../helper/compiledBallot/validator.js";
import { writeCompiledBallot } from "../../helper/compiledBallot/writer.js";

const SAMPLE_PAYLOAD = {
  schemaVersion: "1",
  source: {
    moduleId: "scaffold-demo-module",
    moduleUrl: "https://proposals.example.test/",
    externalBallotId: "scaffold-budget-demo-1",
    version: "scaffold-v1",
  },
  ballot: {
    title: "Scaffold: Budget Demo Ballot",
    description:
      "Demo ballot created by importCompiledBallot.js. Exercises multi-value enum, numeric, and boolean facets.",
    voterType: "drep",
    voterDescription: "Active DReps",
    voteWeighted: true,
    voteFilters: true,
    votePeriodStart: new Date(Date.now() + 60 * 60_000).toISOString(),
    votePeriodEnd: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    proposalPeriodStart: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    proposalPeriodEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
    voteAuthorityId: "scaffold-authority",
    voteAuthorityAddress: "addr_test1scaffoldauthority",
  },
  facets: [
    {
      key: "category",
      label: "Category",
      type: "enum",
      multi: true,
      options: ["education", "infrastructure", "health", "governance"],
      filterable: true,
      sortable: false,
    },
    {
      key: "region",
      label: "Region",
      type: "enum",
      multi: true,
      options: ["LATAM", "EU", "APAC", "AFRICA", "NA"],
      filterable: true,
      sortable: false,
    },
    {
      key: "totalCost",
      label: "Total cost",
      type: "number",
      unit: "ADA",
      filterable: true,
      sortable: true,
      defaultSort: "desc",
    },
    {
      key: "featured",
      label: "Featured",
      type: "boolean",
      filterable: true,
      sortable: false,
    },
  ],
  proposals: [
    {
      title: "Libraries for LATAM",
      voteType: "default",
      voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
      ],
      externalProposal: {
        id: "scaffold-p1",
        url: "https://proposals.example.test/p/1",
        snapshot: {
          title: "Libraries for LATAM",
          summary: "Build 50 community libraries across LATAM.",
          authors: ["Alice", "Bob"],
          version: "1.2",
          facets: {
            category: "education,infrastructure",
            region: "LATAM",
            totalCost: 125000,
            featured: true,
          },
        },
      },
    },
    {
      title: "Rural health network",
      voteType: "default",
      voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
      ],
      externalProposal: {
        id: "scaffold-p2",
        url: "https://proposals.example.test/p/2",
        snapshot: {
          title: "Rural health network",
          summary: "Mobile clinics for APAC + AFRICA rural communities.",
          authors: ["Carol"],
          version: "2.0",
          facets: {
            category: "health",
            region: "APAC,AFRICA",
            totalCost: 250000,
            featured: false,
          },
        },
      },
    },
    {
      title: "Governance toolkit",
      voteType: "default",
      voteOptions: [
        { id: 1, cost: 1, label: "Yes" },
        { id: 2, cost: 1, label: "No" },
      ],
      externalProposal: {
        id: "scaffold-p3",
        url: "https://proposals.example.test/p/3",
        snapshot: {
          title: "Governance toolkit",
          summary: "Open-source tooling for on-chain governance.",
          authors: ["Dave", "Eve"],
          version: "0.9",
          facets: {
            category: "governance",
            region: "EU",
            totalCost: 40000,
            featured: true,
          },
        },
      },
    },
  ],
};

const { flags } = parseArgs();
const validation = validateCompiledBallot(SAMPLE_PAYLOAD);
if (!validation.ok) {
  console.error("[importCompiledBallot] sample payload failed validation:");
  console.error(JSON.stringify(validation.errors, null, 2));
  process.exit(1);
}

if (flags.http) {
  const url =
    (flags.url || process.env.SCAFFOLD_API_URL || "http://localhost:3000").replace(
      /\/+$/,
      ""
    ) + "/api/v1/admin/ballots/import";
  const apiKey = flags.apiKey || process.env.SCAFFOLD_API_KEY;
  if (!apiKey) {
    console.error("[importCompiledBallot] --http requires --apiKey or $SCAFFOLD_API_KEY");
    process.exit(1);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(SAMPLE_PAYLOAD),
  });
  const body = await res.text();
  console.log(`[importCompiledBallot] HTTP ${res.status}`);
  console.log(body);
  process.exit(res.ok ? 0 : 1);
}

// Direct-writer mode (default).
await bootstrap();
try {
  const result = await writeCompiledBallot(SAMPLE_PAYLOAD, {
    method: "upload",
    importedBy: "scaffold-admin",
  });
  console.log("[importCompiledBallot] success:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("[importCompiledBallot] write failed:", err.message);
  process.exitCode = 1;
} finally {
  await teardown();
}
