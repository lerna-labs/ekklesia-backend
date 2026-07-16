/**
 * Per-ballot / per-proposal OpenGraph + Twitter meta injection for the
 * static SPA `index.html`. Sits in front of the SPA fallback in
 * `server.js`. Looks up the ballot/proposal by id, rewrites the ten
 * shared meta tags in the document, and serves the result.
 *
 * Failure modes (any throw, missing ballot/proposal, missing
 * index.html, malformed id) call `next()` so the SPA fallback can serve
 * the generic page. The OG path is purely additive — it must never
 * block the SPA.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { Ballot } from '../../schema/Ballot.js';
import { Proposal } from '../../schema/Proposal.js';
import { rendererVersion } from './ogImage.js';

const TITLE_SUFFIX = 'Ekklesia';
const DESC_LIMIT = 155;
const TITLE_LIMIT_BALLOT = 70;
const TITLE_LIMIT_PROP = 60;

let cachedIndex = null;
let cachedIndexPath = null;

async function loadIndex(indexPath) {
  if (cachedIndex && cachedIndexPath === indexPath) return cachedIndex;
  const html = await fs.readFile(indexPath, 'utf8');
  cachedIndex = html;
  cachedIndexPath = indexPath;
  return cachedIndex;
}

function escapeAttr(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function clamp(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str;
}

function rewriteMeta(html, { title, description, image, url }) {
  const t = escapeAttr(title);
  const d = escapeAttr(description);
  const i = escapeAttr(image);
  const u = escapeAttr(url);
  const tags = [
    [/<title>[^<]*<\/title>/, `<title>${t}</title>`],
    [
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${d}">`,
    ],
    [
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:title" content="${t}">`,
    ],
    [
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:description" content="${d}">`,
    ],
    [
      /<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:image" content="${i}">`,
    ],
    [
      /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:url" content="${u}">`,
    ],
    [
      /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/,
      `<meta name="twitter:title" content="${t}">`,
    ],
    [
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/,
      `<meta name="twitter:description" content="${d}">`,
    ],
    [
      /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/?>/,
      `<meta name="twitter:image" content="${i}">`,
    ],
    [
      /<meta\s+property="twitter:url"\s+content="[^"]*"\s*\/?>/,
      `<meta property="twitter:url" content="${u}">`,
    ],
  ];
  let out = html;
  for (const [pattern, replacement] of tags) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function publicUrl() {
  const raw = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || '').trim();
  if (!raw) return '';
  // Auto-prepend https:// when the operator entered a bare hostname.
  // og:url / og:image must be absolute URLs or scrapers reject the
  // card silently. Trailing slash stripped so we never emit `//ballots`.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function isObjectId(s) {
  return typeof s === 'string' && mongoose.isValidObjectId(s);
}

async function buildBallotMeta(ballotId) {
  if (!isObjectId(ballotId)) return null;
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) return null;

  const ts = ballot.updatedAt ? new Date(ballot.updatedAt).getTime() : 0;
  const v = rendererVersion();
  const base = publicUrl();
  const title = `${clamp(ballot.title, TITLE_LIMIT_BALLOT)} — ${TITLE_SUFFIX}`;
  const description = clamp(ballot.description || `Cast your vote on ${ballot.title}.`, DESC_LIMIT);
  const url = `${base}/ballots/${ballotId}`;
  const image = `${base}/og/ballot/${ballotId}.png?v=${ts}-${v}`;
  return { title, description, url, image, cacheKey: `b-v${v}-${ballotId}-${ts}` };
}

async function buildProposalMeta(ballotId, proposalId) {
  if (!isObjectId(ballotId) || !isObjectId(proposalId)) return null;
  const proposal = await Proposal.findById(proposalId).lean();
  if (!proposal) return null;
  if (proposal.ballotId?.toString() !== ballotId) return null;
  const ballot = await Ballot.findById(ballotId).lean();
  if (!ballot) return null;

  const ts = proposal.updatedAt ? new Date(proposal.updatedAt).getTime() : 0;
  const v = rendererVersion();
  const base = publicUrl();
  const title = `${clamp(proposal.title, TITLE_LIMIT_PROP)} · ${clamp(
    ballot.title,
    30,
  )} — ${TITLE_SUFFIX}`;
  const description = clamp(
    proposal.description || `One of the proposals on the "${ballot.title}" ballot.`,
    DESC_LIMIT,
  );
  const url = `${base}/ballots/${ballotId}/proposals/${proposalId}`;
  const image = `${base}/og/proposal/${proposalId}.png?v=${ts}-${v}`;
  return { title, description, url, image, cacheKey: `p-v${v}-${proposalId}-${ts}` };
}

/**
 * Factory — binds the absolute `index.html` path so the middleware can
 * be mounted from server.js without re-resolving paths on every call.
 */
export function createOgMetaMiddleware({ indexHtmlPath }) {
  return async function ogMetaMiddleware(req, res, next) {
    const { ballotId, proposalId } = req.params;
    try {
      const meta = proposalId
        ? await buildProposalMeta(ballotId, proposalId)
        : await buildBallotMeta(ballotId);
      if (!meta) return next();

      const html = await loadIndex(indexHtmlPath);

      const etag = `"og-${meta.cacheKey}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        ETag: etag,
      });
      res.send(rewriteMeta(html, meta));
    } catch (err) {
      // Never block the SPA on OG failure.
      console.warn(`ogMeta: falling back to SPA (${err.message})`);
      next();
    }
  };
}

// Exposed for tests.
export const _internals = {
  rewriteMeta,
  clamp,
  escapeAttr,
  buildBallotMeta,
  buildProposalMeta,
  publicUrl,
};
