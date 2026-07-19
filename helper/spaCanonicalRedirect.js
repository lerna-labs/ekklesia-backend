// SPA-fallback canonical redirect.
//
// When a user arrives at a SPA URL whose `:ballotId` or `:proposalId`
// segment is the upstream proposals-module identifier instead of the
// canonical Mongo `_id`, this middleware 301-redirects to the
// canonical URL before the SPA boots. Browsers update their address
// bar in front of the user; search engines follow the 301 so only the
// canonical URL appears in the index.
//
// The middleware is mounted in `server.js` on the same param shape
// that the OG-cards middleware already understands:
//   /ballots/:ballotId
//   /ballots/:ballotId/proposals
//   /ballots/:ballotId/proposals/:proposalId
//   /ballots/:ballotId/proposals/:proposalId/results
//
// Failure modes (resolver throws, DB unavailable, ambiguous, no match)
// fall through to `next()` so the SPA still serves a generic page.
// Resolutions are memoized in a small LRU so SPA navigation doesn't
// hammer Mongo with the same lookups.

import { resolveBallot, resolveProposal } from './idResolver.js';

const CACHE_MAX = 1000;
const CACHE_TTL_MS = 60_000;

class TtlLru {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.t > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.v;
  }
  set(key, v) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, t: Date.now() });
    if (this.map.size > this.max) {
      // evict oldest
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

// Separate caches keep ballot/proposal lookups from evicting each
// other on a typical browsing session.
const ballotCache = new TtlLru(CACHE_MAX, CACHE_TTL_MS);
const proposalCache = new TtlLru(CACHE_MAX, CACHE_TTL_MS);

// Sentinel cached for misses + ambiguous results so we don't re-query
// for the same dead input within the TTL window.
const NO_RESOLVE = Symbol('no-canonical-resolution');

async function lookupBallotCanonical(input) {
  const cached = ballotCache.get(input);
  if (cached !== undefined) return cached === NO_RESOLVE ? null : cached;
  const result = await resolveBallot(input, {
    selectFields: { _id: 1 },
  }).catch(() => null);
  if (!result || result.ambiguous) {
    ballotCache.set(input, NO_RESOLVE);
    return null;
  }
  const canonical = String(result.doc._id);
  ballotCache.set(input, canonical);
  return canonical;
}

async function lookupProposalCanonical(input, ballotId) {
  // Cache key includes the resolved parent so the same external
  // proposal id under different ballots doesn't cross-pollinate.
  const key = `${ballotId}::${input}`;
  const cached = proposalCache.get(key);
  if (cached !== undefined) return cached === NO_RESOLVE ? null : cached;
  const result = await resolveProposal(input, {
    ballotId,
    selectFields: { _id: 1 },
  }).catch(() => null);
  if (!result || result.ambiguous) {
    proposalCache.set(key, NO_RESOLVE);
    return null;
  }
  const canonical = String(result.doc._id);
  proposalCache.set(key, canonical);
  return canonical;
}

/**
 * Express middleware. Reads `:ballotId` and (optionally) `:proposalId`
 * from `req.params`, resolves each, and 301-redirects to the canonical
 * URL when either segment was external. Falls through to `next()` on
 * any other outcome.
 *
 * `req.path` shape is preserved (we re-build using the canonical ids
 * + the trailing literal path), and the query string is forwarded
 * verbatim so deep links survive the redirect.
 */
export async function spaCanonicalRedirect(req, res, next) {
  try {
    const { ballotId, proposalId } = req.params;
    if (!ballotId) return next();

    const canonicalBallot = await lookupBallotCanonical(ballotId);
    if (!canonicalBallot) return next(); // unknown ballot → SPA renders 404

    let canonicalProposal = null;
    if (proposalId) {
      canonicalProposal = await lookupProposalCanonical(proposalId, canonicalBallot);
      if (!canonicalProposal) return next(); // unknown proposal → SPA renders 404
    }

    const ballotChanged = canonicalBallot !== ballotId;
    const proposalChanged = proposalId && canonicalProposal !== proposalId;
    if (!ballotChanged && !proposalChanged) {
      // Already canonical — no redirect needed.
      return next();
    }

    // Re-build the path. Match each known shape; anything else falls
    // through. We never invent path segments.
    const m =
      req.path.match(/^\/ballots\/[^/]+\/proposals\/[^/]+(\/results)?\/?$/) ||
      req.path.match(/^\/ballots\/[^/]+\/proposals\/?$/) ||
      req.path.match(/^\/ballots\/[^/]+\/?$/);
    if (!m) return next();

    let target;
    if (proposalId) {
      const suffix = /\/results\/?$/.test(req.path) ? '/results' : '';
      target = `/ballots/${canonicalBallot}/proposals/${canonicalProposal}${suffix}`;
    } else if (/\/proposals\/?$/.test(req.path)) {
      target = `/ballots/${canonicalBallot}/proposals`;
    } else {
      target = `/ballots/${canonicalBallot}`;
    }

    const qs = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(301, target + qs);
  } catch (err) {
    // Never block the SPA on canonicalization failure.
    return next();
  }
}

// Exposed for tests.
export const _internals = { TtlLru, ballotCache, proposalCache };
