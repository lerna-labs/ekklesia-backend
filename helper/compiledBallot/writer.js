// CompiledBallot writer — upserts a Ballot + its Proposal set from a
// validated CompiledBallot payload and records an audit row.
//
// Contract with the caller:
//   - The payload MUST have already been validated by validateCompiledBallot.
//   - The writer enforces the live-ballot freeze: re-imports of a
//     ballot whose status is "live" or "closed" are rejected.
//   - Upsert key on Ballot is (proposalSource.moduleId, proposalSource.externalBallotId).
//   - Proposals are fully replaced on every import (delete-then-insert)
//     so the writer never has to reason about "did this proposal used
//     to exist." Simpler, matches the "module owns the transform"
//     philosophy.

import crypto from "node:crypto";
import mongoose from "mongoose";
import { Ballot } from "../../schema/Ballot.js";
import { Proposal } from "../../schema/Proposal.js";
import { ImportedBallotPayload } from "../../schema/ImportedBallotPayload.js";
import { ensureProposalContentHashes } from "../proposalContent.js";
import { SCHEMA_VERSION } from "./schema.js";

export class CompiledBallotWriteError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.name = "CompiledBallotWriteError";
    this.code = code || "WRITE_FAILED";
    this.status = status;
  }
}

function checksum(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function buildBallotDoc(payload, authCtx) {
  const b = payload.ballot;
  return {
    title: b.title,
    description: b.description,
    ipfsHash: b.ipfsHash ?? null,
    voterType: b.voterType,
    voterGroups: Array.isArray(b.voterGroups) ? b.voterGroups : [],
    voterDescription: b.voterDescription,
    voteWeighted: b.voteWeighted,
    voteFilters: b.voteFilters,
    votePeriodStart: new Date(b.votePeriodStart),
    votePeriodEnd: new Date(b.votePeriodEnd),
    voteAuthorityId: b.voteAuthorityId,
    voteAuthorityAddress: b.voteAuthorityAddress,
    proposalPeriodStart: new Date(b.proposalPeriodStart),
    proposalPeriodEnd: new Date(b.proposalPeriodEnd),
    voterValidationScript: b.voterValidationScript || "voterValidationAlwaysTrue.js",
    rollupScript: b.rollupScript || "rollupBallot.js",
    startupScript: b.startupScript || "startupBallot.js",
    facets: payload.facets || [],
    proposalSource: {
      moduleId: payload.source.moduleId,
      moduleUrl: payload.source.moduleUrl || null,
      externalBallotId: payload.source.externalBallotId,
      version: payload.source.version || null,
      importedAt: new Date(),
      importMethod: authCtx.method,
      importedBy: authCtx.importedBy,
    },
  };
}

function buildProposalDoc(p, ballotId) {
  return {
    ballotId,
    ipfsHash: p.ipfsHash ?? null,
    title: p.title,
    data: p.data ?? undefined,
    voteType: p.voteType ?? "default",
    voteIncrement: p.voteIncrement ?? 1,
    voterBudget: p.voterBudget ?? 1,
    voteOptions: p.voteOptions,
    requireAnswer: p.requireAnswer === true,
    // Promote upstream snapshot fields into first-class Proposal
    // fields so display code reads from one canonical place. The
    // raw snapshot is still archived under externalProposal for
    // audit / drift detection.
    summary: p.externalProposal?.snapshot?.summary ?? "",
    rationale: p.externalProposal?.snapshot?.rationale ?? "",
    authors: Array.isArray(p.externalProposal?.snapshot?.authors)
      ? p.externalProposal.snapshot.authors.map((name) =>
          typeof name === "string" ? { name } : name
        )
      : [],
    version: p.externalProposal?.snapshot?.version ?? null,
    externalProposal: p.externalProposal
      ? {
          id: p.externalProposal.id,
          url: p.externalProposal.url || null,
          snapshot: p.externalProposal.snapshot || null,
        }
      : null,
  };
}

/**
 * Write a validated CompiledBallot to Mongo.
 *
 * @param {object} payload — validated CompiledBallot
 * @param {object} authCtx — { method: "push"|"upload", importedBy: string }
 * @returns {Promise<{ ballotId: string, created: boolean, proposalsImported: number, schemaVersion: string }>}
 */
export async function writeCompiledBallot(payload, authCtx) {
  if (!payload?.source?.moduleId || !payload?.source?.externalBallotId) {
    throw new CompiledBallotWriteError(
      "source.moduleId and source.externalBallotId required",
      { code: "BAD_INPUT" }
    );
  }
  if (!authCtx?.method || !authCtx?.importedBy) {
    throw new CompiledBallotWriteError("authCtx required", { code: "BAD_INPUT", status: 500 });
  }

  const filter = {
    "proposalSource.moduleId": payload.source.moduleId,
    "proposalSource.externalBallotId": payload.source.externalBallotId,
  };

  // Freeze check first — no transaction needed for the read.
  const existing = await Ballot.findOne(filter).select("_id status").lean();
  if (existing && ["live", "closed"].includes(existing.status)) {
    throw new CompiledBallotWriteError(
      `Ballot is ${existing.status}; imports are frozen once voting begins`,
      { code: "BALLOT_FROZEN", status: 409 }
    );
  }

  const ballotDoc = buildBallotDoc(payload, authCtx);
  // Transactions require a replica set. Opt-in via env for production;
  // dev (standalone mongo) runs without atomic guarantees. The worst
  // case here is an interrupted import leaving an old Proposal set
  // alongside the new Ballot — recoverable by re-pushing.
  const useTxn = process.env.MONGO_USE_TRANSACTIONS === "true";
  let ballotId;
  let created = false;
  const run = async (session) => {
    const opts = session ? { session } : {};
    const upserted = await Ballot.findOneAndUpdate(
      filter,
      { $set: ballotDoc },
      { new: true, upsert: true, ...opts }
    );
    ballotId = upserted._id;
    created = existing == null;

    await Proposal.deleteMany({ ballotId }, opts);
    const docs = payload.proposals.map((p) => buildProposalDoc(p, ballotId));
    if (docs.length > 0) {
      await Proposal.insertMany(docs, { ...opts, ordered: true });
    }

    await ImportedBallotPayload.create(
      [
        {
          ballotId,
          schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
          importMethod: authCtx.method,
          importedBy: authCtx.importedBy,
          source: {
            moduleId: payload.source.moduleId,
            moduleUrl: payload.source.moduleUrl || null,
            externalBallotId: payload.source.externalBallotId,
            version: payload.source.version || null,
          },
          checksum: checksum(payload),
          payload,
        },
      ],
      opts
    );
  };

  if (useTxn) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => run(session));
    } finally {
      session.endSession();
    }
  } else {
    await run(null);
  }

  // Stamp per-proposal contentHash outside the transaction — the hash
  // is deterministic from the just-written proposal docs and this keeps
  // the core write path transaction-boundaried.
  await ensureProposalContentHashes(ballotId);

  return {
    ballotId: ballotId.toString(),
    created,
    proposalsImported: payload.proposals.length,
    schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
  };
}
