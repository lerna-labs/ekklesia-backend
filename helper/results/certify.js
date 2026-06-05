// Voting-authority certification orchestrator.
//
// Accepts an admin-supplied (or future on-chain-fetched) payload from
// the voting authority and applies it against the ballot's Hydra-final
// audit evidence to produce an "authority-certified" tally that lives
// alongside — but does not replace — the Hydra-raw tally.
//
// See .claude/plans/jolly-copper-blakely.md for the design rationale.
// See .claude/trds/ for the narrative TRD when delivered to frontend.

import blake from "blakejs";
import { Ballot } from "../../schema/Ballot.js";
import { Result } from "../../schema/Result.js";
import { Proposal } from "../../schema/Proposal.js";
import { CertifiedSnapshot } from "../../schema/CertifiedSnapshot.js";
import { canonicalBytes } from "../canonicalJson.js";
import { forBallot } from "../hydraClient.js";
import { deriveProposalTally } from "./hydraTally.js";

function blake2b256Hex(bytes) {
  return Buffer.from(blake.blake2b(bytes, null, 32)).toString("hex");
}

export class CertifyError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = "CertifyError";
    this.code = code || "CERTIFY_FAILED";
    this.details = details || null;
  }
}

/**
 * Build the same `Map<userId, {voterGroup, votingPower}>` shape
 * `deriveProposalTally` consumes, but sourced from the authority's
 * snapshot instead of UserCache. Ineligible voters are OMITTED from
 * the map so they drop out of every downstream tally.
 */
export function votersByUserIdFromSnapshot(snapshotVoters, auditFull) {
  // Re-use `voterGroupFromHrp` conceptually by inlining — we already
  // know each voter's HRP from the Hydra evidence, which is the
  // authoritative source for role classification.
  const hrpByVoter = new Map();
  for (const v of auditFull?.voters || []) {
    if (v?.voterId) hrpByVoter.set(v.voterId, v.credentialHrp);
  }
  const out = new Map();
  for (const row of snapshotVoters) {
    if (!row.eligible) continue;
    const hrp = (hrpByVoter.get(row.voterId) || "").toLowerCase();
    let voterGroup = "default";
    if (hrp === "drep") voterGroup = "drep";
    else if (hrp === "pool" || hrp === "calidus") voterGroup = "pool";
    else if (hrp === "stake" || hrp === "stake_test") voterGroup = "stake";
    // votingPower stored as a lovelace string in the snapshot; helpers
    // expect a number. Downgrade via Number() — safe up to 2^53 lovelace
    // (~9e15) which is >> total Cardano supply. BigInt everywhere would
    // be cleaner but is a deeper refactor; documented as follow-up.
    const votingPower = Number(row.votingPower || 0);
    out.set(row.voterId, {
      userId: row.voterId,
      voterGroup,
      votingPower,
    });
  }
  return out;
}

/**
 * Ingest validation. Returns on success; throws CertifyError on failure.
 */
export function validatePayload(payload, ballotId) {
  if (!payload || typeof payload !== "object") {
    throw new CertifyError("Missing certification payload", {
      code: "PAYLOAD_REQUIRED",
    });
  }
  const { snapshot, narrative } = payload;
  if (!snapshot && !narrative) {
    throw new CertifyError(
      "Must include `snapshot` and/or `narrative`",
      { code: "PAYLOAD_EMPTY" }
    );
  }
  if (narrative) {
    if (typeof narrative.url !== "string" || !narrative.url) {
      throw new CertifyError("narrative.url is required when narrative is set", {
        code: "NARRATIVE_URL_REQUIRED",
      });
    }
    if (typeof narrative.label !== "string" || !narrative.label) {
      throw new CertifyError("narrative.label is required when narrative is set", {
        code: "NARRATIVE_LABEL_REQUIRED",
      });
    }
  }
  if (!snapshot) return; // narrative-only path — no more checks
  if (snapshot.ballotId && String(snapshot.ballotId) !== String(ballotId)) {
    throw new CertifyError(
      `Snapshot.ballotId (${snapshot.ballotId}) does not match path (${ballotId})`,
      { code: "BALLOT_ID_MISMATCH" }
    );
  }
  if (!Array.isArray(snapshot.voters)) {
    throw new CertifyError("snapshot.voters must be an array", {
      code: "VOTERS_MISSING",
    });
  }
  for (const [i, v] of snapshot.voters.entries()) {
    if (!v || typeof v !== "object") {
      throw new CertifyError(`snapshot.voters[${i}] is not an object`, {
        code: "VOTER_SHAPE",
      });
    }
    if (typeof v.voterId !== "string" || !v.voterId) {
      throw new CertifyError(`snapshot.voters[${i}].voterId missing`, {
        code: "VOTER_ID_MISSING",
      });
    }
    if (typeof v.votingPower !== "string") {
      throw new CertifyError(
        `snapshot.voters[${i}].votingPower must be a decimal string (BigInt-safe)`,
        { code: "VOTER_POWER_SHAPE" }
      );
    }
    if (typeof v.eligible !== "boolean") {
      throw new CertifyError(
        `snapshot.voters[${i}].eligible must be a boolean`,
        { code: "VOTER_ELIGIBLE_SHAPE" }
      );
    }
  }
}

/**
 * The snapshot must cover every voter Hydra recorded in the evidence
 * bundle. Voters in the evidence but not in the snapshot are reported
 * up to a cap so the admin can fix the authority's submission.
 */
export function assertSnapshotCoverage(snapshot, auditFull) {
  const MISSING_CAP = 20;
  const snapshotIds = new Set(snapshot.voters.map((v) => v.voterId));
  const missing = [];
  for (const v of auditFull?.voters || []) {
    if (!v?.voterId) continue;
    // Only require coverage for voters with actual evidence — pre-evidence
    // placeholder rows (evidence === null) aren't in the tally anyway.
    if (!v.evidence) continue;
    if (!snapshotIds.has(v.voterId)) {
      missing.push(v.voterId);
      if (missing.length > MISSING_CAP) break;
    }
  }
  if (missing.length > 0) {
    throw new CertifyError(
      "Snapshot is missing voters present in Hydra evidence",
      {
        code: "SNAPSHOT_COVERAGE_INCOMPLETE",
        details: { missingVoterIds: missing.slice(0, MISSING_CAP) },
      }
    );
  }
}

/**
 * Main entry. Takes an admin payload + ballot, writes a new
 * CertifiedSnapshot row (or returns the existing row for an identical
 * re-submission), updates the Result docs, flips Ballot state.
 *
 * @param {object} args
 * @param {string} args.ballotId
 * @param {string} args.submittedBy — admin userId (or "chain")
 * @param {"api"|"chain"} args.source
 * @param {string|null} args.chainTxHash
 * @param {object} args.payload — {snapshot?, snapshotUrl?, narrative?}
 * @returns {Promise<{version, snapshotId, proposalsUpdated, narrativeOnly, idempotent}>}
 */
export async function certifyBallot({
  ballotId,
  submittedBy,
  source = "api",
  chainTxHash = null,
  payload,
}) {
  validatePayload(payload, ballotId);

  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) {
    throw new CertifyError(`Ballot ${ballotId} not found`, {
      code: "BALLOT_NOT_FOUND",
    });
  }

  const { snapshot, snapshotUrl, narrative } = payload;
  const narrativeOnly = !snapshot;

  // Canonical-bytes hash over the whole payload. Used for idempotency so
  // a repeated POST with the exact same snapshot + narrative doesn't
  // bump the version. Narrative-only rows are also idempotent by hash.
  const canonicalPayload = {
    snapshot: snapshot || null,
    narrative: narrative || null,
  };
  const payloadBytes = canonicalBytes(canonicalPayload);
  const payloadHash = blake2b256Hex(payloadBytes);

  const latest = await CertifiedSnapshot.findOne({ ballotId })
    .sort({ version: -1 })
    .lean();
  if (latest && latest.snapshotHash === payloadHash) {
    return {
      version: latest.version,
      snapshotId: latest._id,
      proposalsUpdated: 0,
      narrativeOnly: latest.narrativeOnly,
      idempotent: true,
    };
  }
  const nextVersion = latest ? latest.version + 1 : 1;

  // Narrative-only: skip evidence fetch + derivation. Just persist the
  // CertifiedSnapshot row + update the Ballot's narrative pointer.
  if (narrativeOnly) {
    const snapshotDoc = await CertifiedSnapshot.create({
      ballotId,
      version: nextVersion,
      source,
      chainTxHash,
      submittedBy,
      snapshotUrl: snapshotUrl || null,
      snapshotHash: payloadHash,
      narrativeOnly: true,
      voters: [],
      derivedPerProposal: {},
      narrative: narrative || null,
    });
    await Ballot.updateOne(
      { _id: ballotId },
      {
        $set: {
          authorityNarrative: narrative || null,
          // currentCertifiedVersion is intentionally NOT bumped here —
          // narrative-only endorsements don't flip Result.source to
          // "certified", so the "active certification" pointer only
          // advances on full snapshot ingests.
        },
      }
    );
    return {
      version: nextVersion,
      snapshotId: snapshotDoc._id,
      proposalsUpdated: 0,
      narrativeOnly: true,
      idempotent: false,
    };
  }

  // Full certification path — fetch Hydra evidence, validate coverage,
  // re-derive per proposal.
  let auditFull;
  try {
    const client = await forBallot(ballotId);
    auditFull = await client.auditFull();
  } catch (err) {
    throw new CertifyError(
      `Failed to fetch /audit/full for ballot — staging may have been archived: ${err.message}`,
      { code: "AUDIT_FETCH_FAILED" }
    );
  }
  assertSnapshotCoverage(snapshot, auditFull);

  const votersByUserId = votersByUserIdFromSnapshot(snapshot.voters, auditFull);
  const proposals = await Proposal.find({ ballotId }).lean();
  const derivedPerProposal = {};
  for (const proposal of proposals) {
    const tally = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    derivedPerProposal[proposal._id.toString()] = tally;
  }

  const certifiedAt = new Date();
  const snapshotDoc = await CertifiedSnapshot.create({
    ballotId,
    version: nextVersion,
    source,
    chainTxHash,
    submittedBy,
    snapshotUrl: snapshotUrl || null,
    snapshotHash: payloadHash,
    narrativeOnly: false,
    snapshotEpoch:
      typeof snapshot.snapshotEpoch === "number" ? snapshot.snapshotEpoch : null,
    voters: snapshot.voters,
    derivedPerProposal,
    narrative: narrative || null,
  });

  let proposalsUpdated = 0;
  for (const proposal of proposals) {
    const pid = proposal._id.toString();
    const tally = derivedPerProposal[pid];
    if (!tally) continue;
    await Result.updateOne(
      { proposalId: proposal._id },
      {
        $set: {
          source: "certified",
          certifiedSnapshotId: snapshotDoc._id,
          certifiedVersion: nextVersion,
          certifiedAt,
          certifiedResults: tally.results,
          certifiedResultsByGroup: tally.resultsByGroup,
          // Also update the "latest-best" fields the existing frontend
          // read path consumes so certified results surface without a
          // downstream shape change. The hydra-raw tally remains
          // recoverable through the CertifiedSnapshot history.
          results: tally.results,
          resultsByGroup: tally.resultsByGroup,
          ballotParticipation: tally.ballotParticipation,
          proposalParticipation: tally.proposalParticipation,
          participatingAbstainers: tally.participatingAbstainers,
        },
      },
      { upsert: true }
    );
    proposalsUpdated += 1;
  }

  await Ballot.updateOne(
    { _id: ballotId },
    {
      $set: {
        currentCertifiedVersion: nextVersion,
        ...(narrative ? { authorityNarrative: narrative } : {}),
      },
    }
  );

  return {
    version: nextVersion,
    snapshotId: snapshotDoc._id,
    proposalsUpdated,
    narrativeOnly: false,
    idempotent: false,
  };
}
