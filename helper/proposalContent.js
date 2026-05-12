// Per-proposal content blob — the self-sufficient audit artifact that
// anchors every voter-facing field to `ekklesia.merkleRoot` via a
// blake2b_256 hash committed in `BallotQuestion.contentHash`.
//
// Design goals (see .claude/plans/ballot-content-permanence.md):
//   - The blob stands alone: given only this blob, a frontend can
//     render the full question + every option + voter controls. The
//     `parent` back-link is a chain-of-custody pointer, not a runtime
//     dependency.
//   - Byte-stable: canonical JSON (sorted keys, no whitespace) so
//     re-hashing the same logical object reproduces the same bytes
//     5 years from now.
//   - Covers what voters actually saw: label, description,
//     referenceUrl, imageUrl, per-option metadata, proposal
//     rationale/summary/authors. Stuff that's UI flavor only
//     (facets, data.* descriptions, snapshot provenance) is out.
//
// Hydra commits to the hash, not the content. Hydra doesn't read or
// interpret this blob — it just includes `contentHash` in what
// `ekklesia.merkleRoot` covers.

import blake from "blakejs";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";
import { canonicalBytes } from "./canonicalJson.js";

const SCHEMA_VERSION = "1";

function blake2b256Hex(bytes) {
  return Buffer.from(blake.blake2b(bytes, null, 32)).toString("hex");
}

/**
 * Method-specific vote-rule fields copied into the blob so the blob is
 * renderable without the parent ballot JSON. Only fields relevant to
 * the voteType are included — others are omitted so the blob is tight.
 */
function voteRulesFor(proposal) {
  const rules = { requireAnswer: proposal.requireAnswer === true };
  switch (proposal.voteType) {
    case "choice":
      rules.minSelections = 1;
      rules.maxSelections = 1;
      break;
    case "multi-choice":
      rules.minSelections = Number.isFinite(Number(proposal.minSelections))
        ? Number(proposal.minSelections)
        : 1;
      rules.maxSelections = Number.isFinite(Number(proposal.maxSelections))
        ? Number(proposal.maxSelections)
        : (proposal.voteOptions || []).length;
      break;
    case "budget":
      rules.minSelections = 1;
      rules.maxSelections = (proposal.voteOptions || []).length;
      rules.voterBudget = Number(proposal.voterBudget) || 0;
      break;
    case "weighted":
      rules.budget = Number(proposal.voterBudget) || 0;
      break;
    case "ranked":
      rules.rankCount = (proposal.voteOptions || []).filter((o) => o.id !== "abstain").length;
      break;
    case "scale":
      rules.step = Number(proposal.voteIncrement) || 1;
      break;
    case "likert": {
      const range = proposal.ratingRange || { min: 1, max: 5, step: 1 };
      rules.ratingRange = {
        min: Number(range.min),
        max: Number(range.max),
        step: Number(range.step) || 1,
      };
      break;
    }
  }
  return rules;
}

/**
 * Option as it appears in the committed content blob. Mirrors the
 * typed Proposal voteOption subschema: every voter-facing field is
 * included; voteType-specific fields (cost) only when meaningful so
 * the blob is tight and the hash doesn't churn on unrelated edits.
 *
 * cost is only emitted when the parent voteType is "budget" (knapsack)
 * AND the option has it set. For every other voteType cost is
 * semantically meaningless and is omitted entirely.
 */
function normalizeOption(opt, voteType) {
  const out = {
    id: opt.id,
    label: opt.label,
  };
  if (voteType === "budget" && opt.cost != null) {
    out.cost = Number(opt.cost);
  }
  if (opt.description != null) out.description = opt.description;
  if (opt.referenceUrl != null) out.referenceUrl = opt.referenceUrl;
  if (opt.imageUrl != null) out.imageUrl = opt.imageUrl;
  if (opt.metadata != null) out.metadata = opt.metadata;
  return out;
}

/**
 * Build the canonical content blob for a single proposal.
 *
 * @param {Object} proposal — lean Proposal doc
 * @param {Object} ballot   — lean Ballot doc (for parent back-link)
 * @returns {Object} a plain object suitable for canonicalBytes()
 */
export function buildProposalContentBlob(proposal, ballot) {
  const blob = {
    schemaVersion: SCHEMA_VERSION,
    proposalId: proposal._id.toString(),
    title: proposal.title,
    summary: proposal.summary || "",
    rationale: proposal.rationale || "",
    authors: Array.isArray(proposal.authors)
      ? proposal.authors.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean)
      : [],
    version: proposal.version || null,
    method: proposal.voteType,
    voteRules: voteRulesFor(proposal),
    options: (proposal.voteOptions || []).map((o) => normalizeOption(o, proposal.voteType)),
    parent: {
      ballotId: ballot._id.toString(),
      ballotTitle: ballot.title,
      // ballotCid + ekklesiaMerkleRoot populate once Hydra /prepare
      // confirms. Null until then — still deterministic because null
      // is distinct from absent in canonicalJson.
      ballotCid: ballot.ballotCid || null,
      ekklesiaMerkleRoot: ballot.ekklesiaMerkleRoot || null,
    },
  };

  // Upstream provenance — present only on imported proposals.
  if (proposal.externalProposal?.id) {
    blob.externalProposalRef = {
      moduleId: ballot.proposalSource?.moduleId || null,
      externalProposalId: proposal.externalProposal.id,
      url: proposal.externalProposal.url || null,
    };
  }
  return blob;
}

/**
 * Canonical bytes (UTF-8) of the content blob — exactly the sequence
 * that blake2b_256 is computed over. Exported so the content endpoint
 * can stream byte-identical bytes to auditors.
 */
export function canonicalContentBytes(proposal, ballot) {
  return canonicalBytes(buildProposalContentBlob(proposal, ballot));
}

/**
 * Compute + stamp contentHash for a single proposal. Re-reads the ballot
 * to pick up current ballotCid / ekklesiaMerkleRoot values.
 *
 * @param {Object|string} proposalIdOrDoc — either an ObjectId/string or a lean doc
 * @returns {Promise<string|null>} the stamped contentHash (hex), or null on failure
 */
export async function stampProposalContentHash(proposalIdOrDoc) {
  const proposal =
    typeof proposalIdOrDoc === "object" && proposalIdOrDoc._id
      ? proposalIdOrDoc
      : await Proposal.findById(proposalIdOrDoc).lean();
  if (!proposal) return null;
  const ballot = await Ballot.findById(proposal.ballotId).lean();
  if (!ballot) return null;
  const bytes = canonicalContentBytes(proposal, ballot);
  const hash = blake2b256Hex(bytes);
  await Proposal.updateOne({ _id: proposal._id }, { $set: { contentHash: hash } });
  return hash;
}

/**
 * Stamp contentHash on every proposal of a ballot. Called by both the
 * scaffold (ballotFactory) and the CompiledBallot writer after proposals
 * land, so hashes stay in sync with proposal content.
 */
export async function ensureProposalContentHashes(ballotId) {
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) return 0;
  const proposals = await Proposal.find({ ballotId }).lean();
  let stamped = 0;
  for (const p of proposals) {
    const bytes = canonicalContentBytes(p, ballot);
    const hash = blake2b256Hex(bytes);
    if (p.contentHash !== hash) {
      await Proposal.updateOne({ _id: p._id }, { $set: { contentHash: hash } });
      stamped += 1;
    }
  }
  return stamped;
}
