// Dispatcher across ballot sources. Each adapter exports:
//   - `source`: string discriminator ("legacy" | "hydra" | ...)
//   - `ownershipMatch()`: Mongo filter restricting to this source
//   - `list({ filter, sort, skip, limit })`: { items, total } in unified shape
//   - `get(id)`: unified doc or null
//   - `toUnified(doc)`: adapter-specific row → unified shape
//
// Add new sources by dropping a sibling file in this folder and registering it below.

import * as legacyAdapter from './legacyAdapter.js';
import * as hydraAdapter from './hydraAdapter.js';

export const adapters = [legacyAdapter, hydraAdapter];

export function getAdapter(source) {
  return adapters.find((a) => a.source === source) ?? null;
}

/**
 * List across all adapters. For Phase 1 the Hydra adapter returns empty, so
 * the paginated response is effectively legacy-only; once Phase 2 lands the
 * Hydra adapter contributes too and results are merged + re-sorted.
 *
 * @param {Object} options
 * @param {Object} [options.filter] — shared Mongo-ish filter (title regex, voterType, status). Adapters ignore keys they don't understand.
 * @param {Object} [options.sort] — sort spec; default `{ votePeriodEnd: -1 }`.
 * @param {number} [options.page]
 * @param {number} [options.limit]
 * @param {string} [options.source] — restrict to one adapter.
 */
export async function listUnified({
  filter = {},
  sort = { votePeriodEnd: -1 },
  page = 1,
  limit = 10,
  source,
} = {}) {
  const active = source ? [getAdapter(source)].filter(Boolean) : adapters;
  if (active.length === 0) {
    return { items: [], pagination: { total: 0, page, limit, totalPages: 0 } };
  }

  // Simple strategy: fetch up to `page*limit` from each adapter, merge, sort, slice.
  // Good enough while Hydra adapter is a stub; optimize in Phase 2 if needed.
  const take = page * limit;
  const perSource = await Promise.all(
    active.map((adapter) => adapter.list({ filter, sort, skip: 0, limit: take })),
  );

  const merged = perSource.flatMap((r) => r.items);
  const total = perSource.reduce((sum, r) => sum + r.total, 0);

  merged.sort(makeComparator(sort));

  const start = (page - 1) * limit;
  const paged = merged.slice(start, start + limit);

  return {
    items: paged,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getUnified(id) {
  for (const adapter of adapters) {
    const doc = await adapter.get(id);
    if (doc) return doc;
  }
  return null;
}

function makeComparator(sortSpec) {
  const entries = Object.entries(sortSpec);
  return (a, b) => {
    for (const [key, dir] of entries) {
      const av = a[key];
      const bv = b[key];
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      if (av < bv) return dir === 1 ? -1 : 1;
      if (av > bv) return dir === 1 ? 1 : -1;
    }
    return 0;
  };
}
