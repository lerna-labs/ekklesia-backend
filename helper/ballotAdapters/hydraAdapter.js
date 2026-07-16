// Reads Hydra-backed ballots. The local Mongo Ballot doc is authoritative
// for metadata (title, description, dates, source discriminator, hydra
// coordinates) and is written by the admin /prepare flow. This adapter
// enriches listings with live state queried from the Hydra instance when
// the data is cheap to fetch; heavier details are fetched per-ballot on
// `get()`.

import mongoose from 'mongoose';
import { Ballot } from '../../schema/Ballot.js';
import { forBallot, HydraClientError } from '../hydraClient.js';

export const source = 'hydra';

export function ownershipMatch() {
  return { source: 'hydra' };
}

export async function list({
  filter = {},
  sort = { votePeriodEnd: -1 },
  skip = 0,
  limit = 10,
} = {}) {
  const match = { ...ownershipMatch(), ...filter };
  const total = await Ballot.countDocuments(match);
  const docs = await Ballot.find(match).sort(sort).skip(skip).limit(limit).lean();
  return { items: docs.map(toUnified), total };
}

export async function get(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Ballot.findOne({ _id: id, ...ownershipMatch() }).lean();
  if (!doc) return null;

  const unified = toUnified(doc);
  // Best-effort enrichment from the live Hydra instance. Failures are
  // non-fatal — the row still renders from local metadata.
  try {
    const client = await forBallot(id);
    const [headInfo, ballot] = await Promise.all([
      client.headInfo().catch(() => null),
      client.ballot().catch(() => null),
    ]);
    unified.hydra = {
      ...unified.hydra,
      headInfo: headInfo ?? null,
      ballot: ballot ?? null,
    };
  } catch (err) {
    if (!(err instanceof HydraClientError)) {
      console.warn(`[hydraAdapter.get] enrichment failed for ${id}: ${err.message}`);
    }
  }
  return unified;
}

export function toUnified(doc) {
  return {
    id: doc._id?.toString() ?? doc.id,
    source: 'hydra',
    title: doc.title,
    description: doc.description,
    status: doc.status,
    voterType: doc.voterType,
    voterGroups: Array.isArray(doc.voterGroups) ? doc.voterGroups : [],
    voterDescription: doc.voterDescription,
    voteWeighted: doc.voteWeighted,
    votePeriodStart: doc.votePeriodStart,
    votePeriodEnd: doc.votePeriodEnd,
    voteFilters: doc.voteFilters,
    ipfsHash: doc.ipfsHash ?? null,
    proposalCount: null, // populated by enrichment when applicable
    singleProposal: null,
    hydra: {
      endpoint: doc.hydraEndpoint ?? null,
      headId: doc.hydraHeadId ?? null,
      headStatus: doc.hydraHeadStatus ?? null,
      ballotCid: doc.ballotCid ?? null,
      instancePolicyId: doc.instancePolicyId ?? null,
      prepareTxHash: doc.prepareTxHash ?? null,
      prepareTxSubmittedAt: doc.prepareTxSubmittedAt ?? null,
    },
    provisionalResultsEnabled: doc.provisionalResultsEnabled ?? false,
    proposalSource: doc.proposalSource?.moduleId ? doc.proposalSource : null,
    facets: Array.isArray(doc.facets) ? doc.facets : [],
    votingPowerSource: doc.votingPowerSource
      ? {
          type: doc.votingPowerSource.type || 'snapshot',
          uploadedAt: doc.votingPowerSource.uploadedAt || null,
        }
      : null,
    // Authority-certification surface. Populated by
    // POST /api/v1/admin/ballots/:id/certify. `certified: true` iff at
    // least one full-snapshot certification has landed (narrative-only
    // endorsements don't bump `currentCertifiedVersion`, matching the
    // contract in .claude/trds/FRONTEND_CERTIFIED_RESULTS_V1.md). The
    // richer per-proposal tally + version history lives behind the
    // dedicated GET /api/v1/ballots/:id/certified endpoint — this is
    // the cheap label-ready shape for the main ballot view.
    certification: {
      certified: typeof doc.currentCertifiedVersion === 'number',
      version: doc.currentCertifiedVersion ?? null,
      narrative: doc.authorityNarrative ?? null,
    },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
