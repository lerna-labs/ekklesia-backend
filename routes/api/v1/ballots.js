// GET /api/v1/ballots — unified listing across all ballot sources.
//
// Accepts the same query shape as /api/v0/ballots for frontend parity, plus
// an optional `source` filter to restrict to a single adapter. Each returned
// row carries a `source` discriminator so the frontend can render conditionally.

import { Router } from 'express';
import validator from 'validator';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import blake from 'blakejs';
import { escapeRegex } from '../../../helper/escapeRegex.js';
import { listUnified, getUnified } from '../../../helper/ballotAdapters/index.js';
import { Ballot } from '../../../schema/Ballot.js';
import { Proposal } from '../../../schema/Proposal.js';
import { CertifiedSnapshot } from '../../../schema/CertifiedSnapshot.js';
import {
  buildProposalContentBlob,
  canonicalContentBytes,
} from '../../../helper/proposalContent.js';
import { canonicalBytes } from '../../../helper/canonicalJson.js';

const router = Router();

function blake2b256Hex(bytes) {
  return Buffer.from(blake.blake2b(bytes, null, 32)).toString('hex');
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * State-aware cache TTL (seconds). Results are served separately via
 * /api/v1/results/*, so a ballot's definition is effectively static for
 * its lifetime — the main reason to invalidate is a status transition
 * (upcoming → live → closed) or admin metadata changes.
 */
function ballotMaxAge(status) {
  switch (status) {
    case 'closed':
      return 3600; // 1h — changes are extremely rare
    case 'live':
      return 120; // 2m — rolling status + window fields matter
    case 'upcoming':
    default:
      return 30; // 30s — admin may still be editing
  }
}

function applyBallotCache(res, doc) {
  if (!doc) {
    res.set('Cache-Control', 'no-store');
    return;
  }
  const maxAge = ballotMaxAge(doc.status);
  res.set('Cache-Control', `public, max-age=${maxAge}`);
}

router.get('/', async (req, res) => {
  const { voterType, status, search, page = 1, limit = 10, source } = req.query;

  const filter = {};

  if (search) {
    if (!validator.isLength(search, { min: 1, max: 100 })) {
      return res.status(400).json({
        status: 'error',
        message: 'Search term must be between 1 and 100 characters',
      });
    }
    if (['$', '{', '}'].some((c) => search.includes(c))) {
      return res.status(400).json({
        status: 'error',
        message: 'Search contains invalid characters',
      });
    }
    // Pass the regex as a string with $options:"i" — `new RegExp(...)`
    // throws SyntaxError on unbalanced metachars (`(`, `[`, ...) and
    // reflects the failing pattern in the 500. escapeRegex neutralizes
    // every metachar so $regex receives a literal substring match.
    filter.$or = [{ title: { $regex: escapeRegex(search), $options: 'i' } }];
    if (validator.isMongoId(search)) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(search) });
    }
  }

  if (voterType) {
    if (!validator.isAlphanumeric(voterType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid voterType format',
      });
    }
    filter.voterType = { $regex: `^${escapeRegex(voterType)}$`, $options: 'i' };
  }

  if (status) {
    if (!['live', 'closed', 'upcoming'].includes(status.toLowerCase())) {
      return res.status(400).json({
        status: 'error',
        message: "Invalid status parameter, must be 'live', 'closed', or 'upcoming'",
      });
    }
    filter.status = status.toLowerCase();
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  if (isNaN(pageNum) || pageNum < 1) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid page parameter, must be a positive integer',
    });
  }
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid limit parameter, must be a positive integer between 1 and 100',
    });
  }

  if (source && !['legacy', 'hydra'].includes(source)) {
    return res.status(400).json({
      status: 'error',
      message: "Invalid source parameter, must be 'legacy' or 'hydra'",
    });
  }

  try {
    const result = await listUnified({
      filter,
      page: pageNum,
      limit: limitNum,
      source,
    });
    // Listing cache: 60s — long enough to matter, short enough that a new
    // ballot or status flip lands reasonably quickly.
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ data: result.items, pagination: result.pagination });
  } catch (error) {
    console.error('Error fetching unified ballots:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error while fetching ballots',
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await getUnified(req.params.id);
    if (!doc) {
      return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    }
    applyBallotCache(res, doc);
    return res.status(200).json({ data: doc });
  } catch (error) {
    console.error('Error fetching ballot:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error while fetching ballot',
    });
  }
});

// ----------------------------------------------------------------------
// Audit endpoints (public, unauthenticated) — long-term auditability
// requires no gate. Chain of custody:
//   on-chain (600) datum → ekklesia.merkleRoot
//     → IPFS-pinned ballot JSON (hash covers BallotQuestion.contentHash[n])
//        → per-proposal content blob (hash = Proposal.contentHash)
// ----------------------------------------------------------------------

/**
 * Per-proposal canonical content bytes. Byte-identical to what
 * `Proposal.contentHash` was computed over. Auditors re-hash these
 * bytes with blake2b_256 to verify the proposal hasn't drifted since
 * ballot-prepare time.
 */
router.get('/:id/questions/:qid/content', async (req, res) => {
  try {
    const ballot = await Ballot.findById(req.params.id).lean();
    if (!ballot) {
      return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    }
    const proposal = await Proposal.findOne({
      _id: req.params.qid,
      ballotId: ballot._id,
    }).lean();
    if (!proposal) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Proposal not found on this ballot' });
    }
    const bytes = canonicalContentBytes(proposal, ballot);
    applyBallotCache(res, ballot);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Length', String(bytes.length));
    return res.end(bytes);
  } catch (err) {
    console.error('[ballots/:id/questions/:qid/content]', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

/**
 * Full archive bundle — one JSON file carrying every voter-facing
 * committed field, a MANIFEST of per-file hashes, and a README with
 * the verification recipe. Designed to be saved to disk and re-pinned
 * to IPFS by anyone who cares about long-term audit.
 */
router.get('/:id/archive', async (req, res) => {
  try {
    const ballot = await Ballot.findById(req.params.id).lean();
    if (!ballot) {
      return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    }
    const proposals = await Proposal.find({ ballotId: ballot._id }).lean();

    // Canonical ballot summary. Not byte-identical to Hydra's pinned
    // ballot JSON (Hydra adds merkleRoot + ballotIpfsCid, full role-
    // weighting, etc.) — it covers the voter-facing subset so the
    // archive stands alone.
    const ballotBlob = {
      id: ballot._id.toString(),
      title: ballot.title,
      description: ballot.description,
      voterType: ballot.voterType || 'any',
      voterDescription: ballot.voterDescription,
      voterGroups: ballot.voterGroups || [],
      votePeriodStart:
        ballot.votePeriodStart instanceof Date
          ? ballot.votePeriodStart.toISOString()
          : ballot.votePeriodStart,
      votePeriodEnd:
        ballot.votePeriodEnd instanceof Date
          ? ballot.votePeriodEnd.toISOString()
          : ballot.votePeriodEnd,
      voteAuthorityId: ballot.voteAuthorityId,
      voteAuthorityAddress: ballot.voteAuthorityAddress,
      hydra: {
        ballotCid: ballot.ballotCid || null,
        ekklesiaMerkleRoot: ballot.ekklesiaMerkleRoot || null,
        headId: ballot.hydraHeadId || null,
        instancePolicyId: ballot.instancePolicyId || null,
      },
    };
    const ballotBytes = canonicalBytes(ballotBlob);

    const proposalEntries = proposals.map((p) => {
      const blob = buildProposalContentBlob(p, ballot);
      const bytes = canonicalContentBytes(p, ballot);
      return {
        proposalId: p._id.toString(),
        content: blob,
        bytes: bytes.length,
        contentHash: blake2b256Hex(bytes),
        sha256: sha256Hex(bytes),
      };
    });

    const manifest = [
      {
        path: 'ballot.json',
        bytes: ballotBytes.length,
        blake2b_256: blake2b256Hex(ballotBytes),
        sha256: sha256Hex(ballotBytes),
      },
      ...proposalEntries.map((e) => ({
        path: `proposals/${e.proposalId}.json`,
        bytes: e.bytes,
        blake2b_256: e.contentHash,
        sha256: e.sha256,
      })),
    ];

    const bundle = {
      schemaVersion: '1',
      generatedAt: new Date().toISOString(),
      ballot: ballotBlob,
      proposals: Object.fromEntries(proposalEntries.map((e) => [e.proposalId, e.content])),
      manifest,
      readme: [
        'This bundle covers every voter-facing field committed on-chain by the',
        'Hydra middleware via `ekklesia.merkleRoot` on the (600) datum.',
        '',
        "Verify a single proposal's content matches the committed hash:",
        '  1. Extract `proposals[<proposalId>]`.',
        '  2. Canonicalize: sort object keys lexicographically, UTF-8 encode,',
        '     no whitespace between tokens (see docs/ballot-audit.md for rules).',
        '  3. Compute blake2b_256 over the canonical bytes.',
        '  4. Compare the hex to `manifest[].blake2b_256` for the matching file.',
        '',
        'Chain up to on-chain commitment:',
        "  - Fetch `ballot.hydra.ballotCid` from IPFS; that JSON's",
        '    `questions[].contentHash` values should match this manifest.',
        '  - That pinned ballot JSON is what `ballot.hydra.ekklesiaMerkleRoot`',
        '    is computed over — re-hash to confirm.',
        '  - `ekklesiaMerkleRoot` is anchored on-chain in the (600) ballot-',
        "    instance datum. That's the terminus of the chain of custody.",
      ].join('\n'),
    };

    applyBallotCache(res, ballot);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="ballot-${ballot._id}-archive.json"`);
    return res.status(200).json(bundle);
  } catch (err) {
    console.error('[ballots/:id/archive]', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// GET /api/v1/ballots/:id/certified — authority-certification state
//
// Surfaces the currently-active CertifiedSnapshot (if any) plus version
// history so the frontend can label results as "Certified at version N
// by <authority>" vs. "Provisional (Hydra-final, not yet certified)".
//
// Shape when certified:
//   { certified: true, version, certifiedAt, snapshotUrl, snapshotHash,
//     snapshotEpoch, narrative: {url,label}|null, perProposal: [...],
//     history: [{version, submittedAt, narrativeOnly, ...}] }
//
// Shape when not yet certified (no CertifiedSnapshot rows exist):
//   { certified: false, narrative: null, history: [] }
//
// When only narrative has been published (narrativeOnly: true at every
// version), `certified` is false but `narrative` is set.
router.get('/:id/certified', async (req, res) => {
  try {
    const ballot = await Ballot.findById(req.params.id).lean();
    if (!ballot) {
      return res.status(404).json({ status: 'error', message: 'Ballot not found' });
    }
    const all = await CertifiedSnapshot.find({ ballotId: ballot._id }).sort({ version: -1 }).lean();
    const history = all.map((s) => ({
      version: s.version,
      submittedAt: s.submittedAt,
      submittedBy: s.submittedBy,
      source: s.source,
      chainTxHash: s.chainTxHash,
      snapshotUrl: s.snapshotUrl,
      snapshotHash: s.snapshotHash,
      narrativeOnly: s.narrativeOnly,
      narrative: s.narrative,
    }));
    const activeVersion = ballot.currentCertifiedVersion || null;
    const active = activeVersion ? all.find((s) => s.version === activeVersion) || null : null;
    if (!active) {
      return res.json({
        status: 'success',
        data: {
          certified: false,
          narrative: ballot.authorityNarrative || null,
          history,
        },
      });
    }
    // Materialize per-proposal tally from the active snapshot's stored
    // derivation. Map/object both serialize out as an object via lean().
    const derivedMap = active.derivedPerProposal || {};
    const perProposal = Object.entries(derivedMap).map(([proposalId, t]) => ({
      proposalId,
      results: t?.results || [],
      resultsByGroup: t?.resultsByGroup || {},
    }));
    return res.json({
      status: 'success',
      data: {
        certified: true,
        version: active.version,
        certifiedAt: active.submittedAt,
        snapshotUrl: active.snapshotUrl,
        snapshotHash: active.snapshotHash,
        snapshotEpoch: active.snapshotEpoch,
        narrative: ballot.authorityNarrative || active.narrative || null,
        perProposal,
        history,
      },
    });
  } catch (err) {
    console.error('[ballots/:id/certified]', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

export default router;
