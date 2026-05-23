// Scaffold: build (and optionally import) the Ekklesia CompiledBallot
// for IntersectMBO's "Cardano Budget Process 2026" vote from the raw
// proposal-module MongoDB export.
//
// Design: see .claude/plans/budget-bridge.md. In brief, per proposal:
//   - summary  = the proposer's executive summary, verbatim.
//   - rationale = a deterministic line-by-line budget table built from
//     workPackages[].budgetBreakdown[]. Everything else stays in the
//     proposal module behind the cross-link.
//   - the FULL proposal is anchored by a blake2b-256 hash of its PUBLIC
//     projection (Intersect-only PII stripped) so anyone can re-verify
//     the hash straight from the public API.
//
// The raw export carries Intersect-only fields (kycInfo, contacts, full
// contractingParty, proposer email) that the public API never exposes.
// publicProjection() strips exactly those so the hash preimage matches
// GET /api/v0/proposals/{id} (minus the server-mutable commentCount /
// updatedAt). The projection rule was verified byte-identical across
// all 69 proposals.
//
// Usage:
//   node __scripts/scaffold/buildBudget2026CompiledBallot.js
//       -> validate + emit compiledBallot.json + snapshot bundle (no import)
//   node __scripts/scaffold/buildBudget2026CompiledBallot.js --write
//       -> also import into the LOCAL DB via writeCompiledBallot
//   node __scripts/scaffold/buildBudget2026CompiledBallot.js --http \
//        --url https://<backend> --apiKey <key>
//       -> also POST to /api/v1/admin/ballots/import on a REMOTE instance
//          (preprod/prod). The API key needs the write:ballot-import scope;
//          --apiKey may also be supplied via $SCAFFOLD_API_KEY.
//   flags: --input <export.json>  --out <dir>

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import blake from "blakejs";
import { canonicalize } from "../../helper/canonicalJson.js";
import { validateCompiledBallot } from "../../helper/compiledBallot/validator.js";
import { writeCompiledBallot } from "../../helper/compiledBallot/writer.js";
import { bootstrap, teardown, parseArgs } from "./common/env.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resolvePath = (p) => (isAbsolute(p) ? p : join(repoRoot, p));

// --- Source-of-truth constants (proposal module: cardano-budget-2026) ---

const MODULE_BASE = "https://hydra-voting.intersectmbo.org";
const MODULE_ID = "intersectmbo-hydra-voting";
const VOTE_ID = "69dfeabdc3904a3d239858da"; // votes/cardano-budget-2026
const VOTE_SLUG = "cardano-budget-2026"; // deep-link path segment

// Dates from the proposal module's vote object (vote _id above).
// votePeriodStart is overridden to 2026-05-22 so voting is open
// immediately on the preprod test instance (production value is
// 2026-05-26T12:00:00.000Z).
const PERIODS = {
  proposalPeriodStart: "2026-04-16T12:00:00.000Z",
  proposalPeriodEnd: "2026-05-08T12:00:00.000Z",
  votePeriodStart: "2026-05-23T02:00:00.000Z",
  votePeriodEnd: "2026-06-12T12:00:00.000Z",
};

// strategyFramework.pillars[] are ObjectIds; titles resolved from the
// vote object's metaData.strategyFramework.pillars[].
const PILLARS = {
  "69dfeabd4979ec8c9da0ad43": "Pillar 1: Infrastructure & Research Excellence",
  "69dfeabd4979ec8c9da0ad44": "Pillar 2: Adoption & Utility",
  "69dfeabd4979ec8c9da0ad45": "Pillar 3: Governance",
  "69dfeabd4979ec8c9da0ad46": "Pillar 4: Community & Ecosystem Growth",
  "69dfeabd4979ec8c9da0ad47": "Pillar 5: Ecosystem Sustainability & Resilience",
};

// voteAuthorityId / voteAuthorityAddress are required non-empty strings
// by the validator. Intersect to supply the real values before a
// production import — kept as obvious placeholders for now.
const AUTHORITY_PLACEHOLDER = "addr_test1vr983c332rmnw4cdpl9ehjfr0j399hmmg7j9gmgdmf7l69qtdtg5x";

// Ballot description (markdown). Bounded by CompiledBallot MAX.description
// (2000 chars).
const BALLOT_DESCRIPTION = `This budget process, designed by the Cardano Budget Committee and supported by Cardano DReps, provides a **transparent, structured, and strategic way to allocate Treasury funds** to initiatives that contribute to the long-term growth of the Cardano ecosystem.

You can review the budget process approved by DReps [here](https://budgetcommittee.docs.intersectmbo.org/cardano-budget-process/cardano-budget-2026-overview)`;

// --- Helpers ----------------------------------------------------------

function blake2b256Hex(bytes) {
  return Buffer.from(blake.blake2b(bytes, null, 32)).toString("hex");
}

/** Unwrap MongoDB extended JSON: {$oid}->string, {$date}->string. */
function normalizeExtendedJson(v) {
  if (Array.isArray(v)) return v.map(normalizeExtendedJson);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$oid") return v.$oid;
    if (keys.length === 1 && keys[0] === "$date") return v.$date;
    const out = {};
    for (const k of keys) out[k] = normalizeExtendedJson(v[k]);
    return out;
  }
  return v;
}

/**
 * Project a raw export record onto the PUBLIC API shape. Strips the
 * Intersect-only PII blocks and the two server-mutable fields. The
 * result is the canonical hash preimage — byte-identical to
 * GET /api/v0/proposals/{id} minus commentCount + updatedAt.
 */
function publicProjection(rawRecord) {
  const r = normalizeExtendedJson(rawRecord);
  delete r.commentCount; // server-mutable counter (absent in export anyway)
  delete r.updatedAt; // server-mutable timestamp
  const md = r.metaData;
  if (md) {
    delete md.kycInfo;
    delete md.legalDeclarations;
    delete md.primaryContact;
    delete md.signatoryContact;
    if (md.contractingParty) {
      md.contractingParty = {
        legalEntityType: md.contractingParty.legalEntityType,
      };
    }
    if (md.proposerDetails) delete md.proposerDetails.email;
  }
  return r;
}

/** Markdown-table-cell-safe: collapse whitespace, escape pipes. */
function cell(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const usd = (ada, rate) => Math.round(ada * rate).toLocaleString("en-US");

/**
 * Build the deterministic budget-breakdown table (the proposal's
 * rationale). One header note (conversion rate stated once), a row per
 * work package and per budget line item, the Intersect administration
 * fee (only when administrator === "Intersect"), and a total row.
 */
function buildBudgetTable(md, proposalId) {
  const pd = md.proposalDetails || {};
  const rate = pd.conversionRate;
  const wps = pd.workPackages || [];
  const lines = [
    `All figures in ADA; USD shown at this proposal's ADA/USD conversion rate of ${rate}.`,
    "",
    "| Work Package / Item | Cost Category | Total Cost |",
    "|---|---|---|",
  ];

  let lineItemSum = 0;
  for (const wp of wps) {
    const breakdown = wp.budgetBreakdown || [];
    const wpSum = breakdown.reduce((a, b) => a + (b.total || 0), 0);
    lineItemSum += wpSum;
    lines.push(
      `| **${cell(wp.name)}** |  | **${fmt(wpSum)} ADA** ($${usd(wpSum, rate)}) |`
    );
    for (const b of breakdown) {
      const t = b.total || 0;
      lines.push(
        `| ${cell(b.name)} | ${cell(b.costCategory)} | ${fmt(t)} ADA ($${usd(t, rate)}) |`
      );
    }
  }

  const totalBudget = md.totalBudget || 0;
  const fee = totalBudget - lineItemSum;
  const isIntersect = md.administrator === "Intersect";

  // Reconciliation invariant (budget-bridge.md §5.2): Intersect-
  // administered proposals carry a positive admin fee; others must
  // have their line items sum exactly to totalBudget. Fail loud so a
  // table can never silently hide or invent money.
  if (isIntersect && fee <= 0) {
    throw new Error(
      `Proposal ${proposalId}: administrator=Intersect but admin fee is ${fee} (expected > 0)`
    );
  }
  if (!isIntersect && fee !== 0) {
    throw new Error(
      `Proposal ${proposalId}: administrator=${md.administrator} but budget does not reconcile (leftover ${fee})`
    );
  }

  if (isIntersect) {
    lines.push(
      `| **Intersect Budget Administration fee** |  | **${fmt(fee)} ADA** ($${usd(fee, rate)}) |`
    );
  }
  lines.push(
    `| **Total budget** |  | **${fmt(totalBudget)} ADA** ($${usd(totalBudget, rate)}) |`
  );
  return lines.join("\n");
}

/**
 * Build one CompiledBallot proposal entry from an already-projected
 * (public-shape) proposal record.
 */
function buildProposalEntry(projected, snapshotAt) {
  const id = projected._id;
  const md = projected.metaData || {};

  const contentHash = blake2b256Hex(
    Buffer.from(canonicalize(projected), "utf8")
  );

  const pillars = (md.strategyFramework?.pillars || [])
    .map((pid) => {
      const title = PILLARS[pid];
      if (!title) throw new Error(`Proposal ${id}: unknown pillar id ${pid}`);
      return title;
    })
    .sort(); // stable display order (Pillar 1..5), not proposer selection order

  const viewUrl = `${MODULE_BASE}/votes/${VOTE_SLUG}/${id}`;
  const apiUrl = `${MODULE_BASE}/api/v0/proposals/${id}`;

  return {
    title: projected.title,
    voteType: "choice",
    voteOptions: [
      { id: 1, label: "Yes" },
      { id: 2, label: "No" },
    ],
    requireAnswer: false, // per-proposal abstain stays available
    ipfsHash: null,
    externalProposal: {
      id,
      url: viewUrl,
      snapshot: {
        title: projected.title,
        summary: projected.summary, // proposer's executive summary, verbatim
        rationale: buildBudgetTable(md, id),
        authors: [md.proposerDetails?.name].filter(Boolean),
        version: String(projected.version),
        facets: {
          pillar: pillars.join(","),
          totalBudget: md.totalBudget,
          estimatedDuration: md.estimatedDuration,
          treasuryRepayment: md.treasuryRepayment,
          administrator: md.administrator,
          legalEntityType: md.contractingParty?.legalEntityType,
        },
      },
    },
    // Anchors the FULL public proposal (everything the public API
    // exposes) + the cross-links. Distinct from Proposal.contentHash,
    // which the importer computes over the condensed ballot content.
    data: {
      upstream: {
        contentHash,
        hashAlg: "blake2b-256",
        canonicalization: "RFC 8785-style (helper/canonicalJson.js)",
        projection: "public-v0",
        source: MODULE_ID,
        apiUrl,
        viewUrl,
        snapshotAt,
      },
    },
  };
}

// --- Facet definitions ------------------------------------------------

const FACETS = [
  {
    key: "pillar",
    label: "Strategy Pillar",
    type: "enum",
    multi: true,
    options: Object.values(PILLARS),
    filterable: true,
    sortable: false,
  },
  {
    key: "totalBudget",
    label: "Total Budget",
    type: "number",
    unit: "ADA",
    filterable: true,
    sortable: true,
    defaultSort: "desc",
  },
  {
    key: "estimatedDuration",
    label: "Duration",
    type: "number",
    unit: "months",
    filterable: true,
    sortable: true,
  },
  {
    key: "treasuryRepayment",
    label: "Treasury Repayment",
    type: "enum",
    multi: false,
    options: ["Yes", "No"],
    filterable: true,
    sortable: false,
  },
  {
    key: "administrator",
    label: "Administrator",
    type: "enum",
    multi: false,
    options: ["Intersect", "Other"],
    filterable: true,
    sortable: false,
  },
  {
    key: "legalEntityType",
    label: "Entity Type",
    type: "enum",
    multi: false,
    options: ["company", "individual"],
    filterable: true,
    sortable: false,
  },
];

// --- Main -------------------------------------------------------------

async function main() {
  const { flags } = parseArgs();
  const inputPath = resolvePath(flags.input || ".claude/intersectPM.proposals.json");
  const outDir = resolvePath(flags.out || ".claude/budget2026-build");

  console.info(`[budget2026] reading export: ${inputPath}`);
  const rawRecords = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    throw new Error("export must be a non-empty JSON array of proposals");
  }

  const snapshotAt = new Date().toISOString();

  // Project once per proposal; reuse for both the hash and the bundle.
  const built = rawRecords.map((raw) => {
    const projected = publicProjection(raw);
    return { projected, entry: buildProposalEntry(projected, snapshotAt) };
  });

  const payload = {
    schemaVersion: "1",
    source: {
      moduleId: MODULE_ID,
      moduleUrl: MODULE_BASE,
      externalBallotId: VOTE_ID,
      version: `snapshot-${snapshotAt.slice(0, 10)}`,
    },
    ballot: {
      title: "Cardano Budget Process 2026",
      description: BALLOT_DESCRIPTION,
      voterType: "drep",
      voterGroups: [{ group: "drep", powerSource: "StakeBased" }],
      voterDescription:
        "DReps eligible to participate in the Cardano Budget process.",
      voteWeighted: true,
      voteFilters: true,
      ...PERIODS,
      voteAuthorityId: AUTHORITY_PLACEHOLDER,
      voteAuthorityAddress: AUTHORITY_PLACEHOLDER,
      ipfsHash: null,
    },
    facets: FACETS,
    proposals: built.map((b) => b.entry),
  };

  // Validate against the CompiledBallot contract before emitting.
  const validation = validateCompiledBallot(payload);
  if (!validation.ok) {
    console.error("[budget2026] CompiledBallot failed validation:");
    console.error(JSON.stringify(validation.errors, null, 2));
    process.exit(1);
  }

  // Emit the CompiledBallot + the frozen snapshot bundle (the per-
  // proposal hash preimages + a manifest) for offline verification.
  fs.mkdirSync(outDir, { recursive: true });
  const ballotPath = join(outDir, "compiledBallot.json");
  fs.writeFileSync(ballotPath, JSON.stringify(payload, null, 2));

  const snapDir = join(outDir, "snapshot");
  fs.mkdirSync(snapDir, { recursive: true });
  for (const { projected } of built) {
    fs.writeFileSync(
      join(snapDir, `${projected._id}.json`),
      JSON.stringify(projected, null, 2)
    );
  }

  const manifest = {
    generatedAt: snapshotAt,
    source: { moduleId: MODULE_ID, moduleUrl: MODULE_BASE, voteId: VOTE_ID },
    hash: {
      alg: "blake2b-256",
      canonicalization: "RFC 8785-style (helper/canonicalJson.js)",
      preimage:
        "publicProjection: export minus kycInfo/legalDeclarations/primaryContact/" +
        "signatoryContact, contractingParty slimmed to legalEntityType, " +
        "proposerDetails.email + commentCount + updatedAt removed",
      verify:
        "GET /api/v0/proposals/{id}, drop commentCount + updatedAt, " +
        "canonicalize, blake2b-256",
    },
    proposalCount: built.length,
    proposals: built.map(({ projected, entry }) => ({
      id: projected._id,
      title: projected.title,
      upstreamContentHash: entry.data.upstream.contentHash,
      apiUrl: entry.data.upstream.apiUrl,
      viewUrl: entry.data.upstream.viewUrl,
    })),
  };
  fs.writeFileSync(
    join(snapDir, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2)
  );

  // Summary.
  const totalAsk = built.reduce(
    (a, b) => a + (b.entry.externalProposal.snapshot.facets.totalBudget || 0),
    0
  );
  const maxRationale = Math.max(
    ...built.map((b) => b.entry.externalProposal.snapshot.rationale.length)
  );
  console.info(`[budget2026] proposals:        ${built.length}`);
  console.info(`[budget2026] total budget ask: ${fmt(totalAsk)} ADA`);
  console.info(`[budget2026] largest rationale: ${maxRationale} chars (cap 10000)`);
  console.info(`[budget2026] CompiledBallot:   ${ballotPath}`);
  console.info(`[budget2026] snapshot bundle:  ${snapDir}/ (${built.length} files + MANIFEST.json)`);
  console.info("[budget2026] validation:       OK");

  // --http: POST to a remote instance's import endpoint (preprod/prod).
  if (flags.http) {
    const base = (flags.url || process.env.SCAFFOLD_API_URL || "").replace(
      /\/+$/,
      ""
    );
    const apiKey = flags.apiKey || process.env.SCAFFOLD_API_KEY;
    if (!base) {
      console.error("[budget2026] --http requires --url <backend base URL>");
      process.exit(1);
    }
    if (!apiKey) {
      console.error(
        "[budget2026] --http requires --apiKey <key> or $SCAFFOLD_API_KEY " +
          "(the key needs the write:ballot-import scope)"
      );
      process.exit(1);
    }
    const endpoint = `${base}/api/v1/admin/ballots/import`;
    console.info(`[budget2026] --http: POST ${endpoint}`);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(payload),
    });
    console.info(`[budget2026] HTTP ${res.status}`);
    console.info(await res.text());
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  // --write: import directly into the local database.
  if (flags.write) {
    console.info("[budget2026] --write: importing into the local database...");
    await bootstrap();
    try {
      const result = await writeCompiledBallot(payload, {
        method: "upload",
        importedBy: "budget2026-scaffold",
      });
      console.info("[budget2026] import result:", JSON.stringify(result, null, 2));
    } finally {
      await teardown();
    }
    return;
  }

  console.info(
    "[budget2026] done (no import — pass --write for the local DB, or " +
      "--http --url <backend> --apiKey <key> for a remote instance)."
  );
}

main().catch((err) => {
  console.error("[budget2026] failed:", err.message);
  process.exitCode = 1;
});
