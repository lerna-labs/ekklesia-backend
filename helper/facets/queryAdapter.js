// Translate a proposal-list request's ?sort= and ?filter[k]= params
// into a validated Mongo filter + sort spec, honoring the ballot's
// declared facets. Rejects unknown keys, unsortable ?sort targets,
// filter-values outside declared enum options, and attempts to filter
// on non-filterable facets.
//
// Target field path is `externalProposal.snapshot.facets.<key>` for
// imported proposals. For proposals without externalProposal, facets
// are simply absent and won't match — that's intentional.

import { splitCsv } from './validate.js';

export class FacetQueryError extends Error {
  constructor(message, { code = 'BAD_INPUT', path } = {}) {
    super(message);
    this.name = 'FacetQueryError';
    this.code = code;
    this.path = path;
  }
}

function coerceScalar(raw, def) {
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new FacetQueryError(`filter[${def.key}] must be a finite number`, {
        path: `filter.${def.key}`,
      });
    }
    return n;
  }
  if (def.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new FacetQueryError(`filter[${def.key}] must be "true" or "false"`, {
      path: `filter.${def.key}`,
    });
  }
  if (def.type === 'date') {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) {
      throw new FacetQueryError(`filter[${def.key}] must be ISO8601`, {
        path: `filter.${def.key}`,
      });
    }
    return new Date(ms);
  }
  return String(raw);
}

/**
 * Build a Mongo filter clause for a single facet.
 *
 *   enum + multi       → CSV, OR semantics; $in over CSV-encoded values.
 *                         Because proposals store the CSV as-is, we need
 *                         to match against a regex that recognizes the
 *                         token as a whole CSV element.
 *   enum + single      → CSV of length 1; direct equality or $in if
 *                         CSV-of-many was supplied (still OR).
 *   number/date/string → direct equality; CSV of these is accepted as
 *                         $in (OR) purely for consistency with enums.
 *   boolean            → direct equality; CSV not allowed.
 */
function buildFacetClause(def, rawValue) {
  const field = `externalProposal.snapshot.facets.${def.key}`;

  // Numeric range syntax. Accepts:
  //   filter[totalCost][min]=500&filter[totalCost][max]=2000  (object form)
  //   filter[totalCost]=min:500,max:2000                       (csv form)
  //   filter[totalCost]=gte:500                                (single op)
  // Comparison operators: min/gte, max/lte, gt, lt, eq.
  if (def.type === 'number') {
    const range = parseNumericRange(rawValue, def);
    if (range === null) return null;
    if (typeof range === 'number') return { [field]: range };
    return { [field]: range };
  }

  const tokens = splitCsv(rawValue);
  if (tokens.length === 0) return null;

  if (def.type === 'enum') {
    const unknown = tokens.filter((t) => !def.options.includes(t));
    if (unknown.length) {
      throw new FacetQueryError(
        `filter[${def.key}] contains unknown options: ${unknown.join(', ')}`,
        { path: `filter.${def.key}` },
      );
    }
    if (def.multi) {
      // Proposals carry the CSV verbatim in the facet value. A $regex
      // per token matches the token as a whole element (anchored by
      // `,` or string boundaries). Escape the token for regex safety.
      const regexClauses = tokens.map((t) => ({
        [field]: { $regex: `(^|,)${escapeRegex(t)}(,|$)` },
      }));
      return regexClauses.length === 1 ? regexClauses[0] : { $or: regexClauses };
    }
    // Single-value enum: straight $in.
    return { [field]: { $in: tokens } };
  }

  if (def.type === 'boolean' && tokens.length > 1) {
    throw new FacetQueryError(`filter[${def.key}] does not accept multiple values`, {
      path: `filter.${def.key}`,
    });
  }

  const coerced = tokens.map((t) => coerceScalar(t, def));
  return coerced.length === 1 ? { [field]: coerced[0] } : { [field]: { $in: coerced } };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RANGE_OPS = {
  min: '$gte',
  gte: '$gte',
  max: '$lte',
  lte: '$lte',
  gt: '$gt',
  lt: '$lt',
  eq: '$eq',
};

/**
 * Parse a numeric filter value into either a Mongo range predicate
 * ({ $gte, $lte, ... }) or a plain number for exact equality.
 * Returns null when the input produces no usable filter.
 */
function parseNumericRange(raw, def) {
  if (raw == null || raw === '') return null;

  // Object form: filter[totalCost][min]=500&filter[totalCost][max]=2000
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [op, val] of Object.entries(raw)) {
      const mongoOp = RANGE_OPS[op];
      if (!mongoOp) continue;
      const n = Number(val);
      if (!Number.isFinite(n)) {
        throw new FacetQueryError(`filter[${def.key}].${op} must be a finite number`, {
          path: `filter.${def.key}.${op}`,
        });
      }
      out[mongoOp] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  const str = String(raw);

  // CSV with operator prefixes: filter[totalCost]=min:500,max:2000
  if (/^(min|max|gte?|lte?|gt|lt|eq):/i.test(str) || str.includes(',')) {
    const parts = str
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = {};
    let plain = null;
    for (const part of parts) {
      const [op, val] = part.includes(':') ? part.split(':', 2) : [null, part];
      if (op) {
        const mongoOp = RANGE_OPS[op.toLowerCase()];
        if (!mongoOp) {
          throw new FacetQueryError(
            `filter[${def.key}] unknown operator "${op}" (expected min/max/gte/lte/gt/lt/eq)`,
            { path: `filter.${def.key}` },
          );
        }
        const n = Number(val);
        if (!Number.isFinite(n)) {
          throw new FacetQueryError(`filter[${def.key}] ${op}:${val} must be a finite number`, {
            path: `filter.${def.key}`,
          });
        }
        out[mongoOp] = n;
      } else {
        const n = Number(val);
        if (!Number.isFinite(n)) {
          throw new FacetQueryError(`filter[${def.key}] must be a finite number`, {
            path: `filter.${def.key}`,
          });
        }
        plain = plain == null ? [n] : [...plain, n];
      }
    }
    if (plain && Object.keys(out).length === 0) {
      // Multiple plain values → $in for parity with enum CSV semantics.
      return plain.length === 1 ? plain[0] : { $in: plain };
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  // Plain single-value exact match.
  const n = Number(str);
  if (!Number.isFinite(n)) {
    throw new FacetQueryError(`filter[${def.key}] must be a finite number`, {
      path: `filter.${def.key}`,
    });
  }
  return n;
}

// Built-in sort keys that are always available regardless of whether
// the ballot declares them as facets. These map to native Proposal
// fields (not facet dict entries) and default to ascending unless the
// caller specifies otherwise.
const BUILTIN_SORT_KEYS = {
  title: { field: 'title', defaultDir: 1 },
  createdAt: { field: 'createdAt', defaultDir: -1 },
  updatedAt: { field: 'updatedAt', defaultDir: -1 },
};

/**
 * Pick the sort spec. Priority:
 *   1. explicit ?sort=<key>&dir=<asc|desc> — matches builtin or sortable facet
 *   2. facet.defaultSort
 *   3. title ascending (natural alphabetical order)
 *
 * Throws FacetQueryError on unknown key or unsortable facet.
 */
function resolveSort(sortKey, dir, facets) {
  if (sortKey) {
    const builtin = BUILTIN_SORT_KEYS[sortKey];
    if (builtin) {
      const direction = dir === 'asc' ? 1 : dir === 'desc' ? -1 : builtin.defaultDir;
      return {
        spec: { [builtin.field]: direction },
        applied: { key: sortKey, direction: direction === 1 ? 'asc' : 'desc' },
      };
    }
    const def = facets.find((f) => f.key === sortKey);
    if (!def) {
      throw new FacetQueryError(`unknown sort key "${sortKey}"`, { path: 'sort' });
    }
    if (!def.sortable) {
      throw new FacetQueryError(`facet "${sortKey}" is not sortable`, { path: 'sort' });
    }
    const direction = dir === 'asc' ? 1 : dir === 'desc' ? -1 : -1;
    return {
      spec: { [`externalProposal.snapshot.facets.${sortKey}`]: direction },
      applied: { key: sortKey, direction: direction === 1 ? 'asc' : 'desc' },
    };
  }
  const defaulted = facets.find((f) => f.defaultSort);
  if (defaulted) {
    const direction = defaulted.defaultSort === 'asc' ? 1 : -1;
    return {
      spec: { [`externalProposal.snapshot.facets.${defaulted.key}`]: direction },
      applied: { key: defaulted.key, direction: defaulted.defaultSort, source: 'default' },
    };
  }
  return { spec: { title: 1 }, applied: { key: 'title', direction: 'asc', source: 'fallback' } };
}

/**
 * @param {{ facets: Array }} ballot
 * @param {object} query — typically req.query. Filters come as
 *                         query.filter (Express parses `filter[k]=v`
 *                         into an object when extended: true).
 * @returns {{ filter: object, sort: object, applied: object }}
 */
export function buildFacetQuery(ballot, query = {}) {
  const facets = Array.isArray(ballot?.facets) ? ballot.facets : [];
  const defByKey = new Map(facets.map((f) => [f.key, f]));

  const filterClauses = [];
  const appliedFilters = {};

  const rawFilters = query.filter && typeof query.filter === 'object' ? query.filter : {};
  for (const [key, value] of Object.entries(rawFilters)) {
    const def = defByKey.get(key);
    if (!def) {
      throw new FacetQueryError(`unknown filter key "${key}"`, { path: `filter.${key}` });
    }
    if (!def.filterable) {
      throw new FacetQueryError(`facet "${key}" is not filterable`, {
        path: `filter.${key}`,
      });
    }
    const clause = buildFacetClause(def, value);
    if (clause) {
      filterClauses.push(clause);
      appliedFilters[key] = splitCsv(value);
    }
  }

  const filter =
    filterClauses.length === 0
      ? {}
      : filterClauses.length === 1
        ? filterClauses[0]
        : { $and: filterClauses };

  const { spec: sort, applied: appliedSort } = resolveSort(
    query.sort ? String(query.sort) : null,
    query.dir ? String(query.dir) : null,
    facets,
  );

  return {
    filter,
    sort,
    applied: { filters: appliedFilters, sort: appliedSort },
  };
}
