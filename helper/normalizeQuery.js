// Defensive query-parameter normalization for the extended query parser.
//
// Express 5 with `app.set("query parser", "extended")` parses
// `?status[$ne]=null` as `{ $ne: "null" }` and `?status=a&status=b` as
// `["a", "b"]`. Both shapes break route handlers that assume a string
// (`.toLowerCase()`, `validator.escape`, `new RegExp(...)`), and the
// thrown TypeError surfaces as a 500 with the JS error message reflected
// to the caller — see issues #40, #44, #50 in the security audit.
//
// We KEEP the extended parser because the v1 facet adapter
// (helper/facets/queryAdapter.js) relies on bracket nesting for the
// `filter[<key>]=<value>` shape. Instead, this middleware refuses any
// non-string value on the known scalar query keys: arrays (duplicate
// params) and objects (NoSQL operator injection) both produce a clean
// 400 BAD_INPUT instead of an unhandled TypeError.
//
// The list below enumerates every scalar query parameter the codebase
// reads today. Adding a new query param? Add it here. The fallback for
// unknown keys is "leave it alone" so the facet adapter's nested
// filter/sort objects pass through untouched.

const SCALAR_QUERY_KEYS = new Set([
  // Pagination & sorting (used by every list endpoint)
  'page',
  'limit',
  'sort',
  'direction',
  'dir',
  // Search / text filters
  'search',
  'voterType',
  'status',
  'source',
  'hasVoted',
  'tags',
  'categories',
  'featured',
  'userType',
  'proposal',
  'includeTerminal',
  'refresh',
]);

export function normalizeQuery(req, res, next) {
  const q = req.query;
  if (!q || typeof q !== 'object') return next();

  for (const key of SCALAR_QUERY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(q, key)) continue;
    const v = q[key];
    if (v == null) continue;
    if (typeof v === 'string') continue;
    // Reject everything that isn't a string. Arrays and plain objects both
    // indicate a malformed or injected query — surface a single error
    // shape so the route never sees a non-string value.
    return res.status(400).json({
      status: 'error',
      code: 'BAD_INPUT',
      message: `Invalid shape for query parameter: ${key}`,
    });
  }
  return next();
}
