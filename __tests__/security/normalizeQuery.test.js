// Regression coverage for issues #40 / #44.
//
// `app.set("query parser", "extended")` causes `?status[$ne]=null` to
// land as `req.query.status = { $ne: "null" }` and `?status=a&status=b`
// as `req.query.status = ["a", "b"]`. Both shapes used to surface as a
// 500 with the underlying TypeError reflected back to the caller. The
// normalizer rejects non-string scalars with a clean 400.

import { normalizeQuery } from '../../helper/normalizeQuery.js';

function runMiddleware(query) {
  const req = { query };
  let status = null;
  let body = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  let nextCalled = false;
  normalizeQuery(req, res, () => {
    nextCalled = true;
  });
  return { status, body, nextCalled };
}

describe('normalizeQuery (security)', () => {
  test.each([
    ['status', { $ne: 'null' }],
    ['voterType', { $gt: '0' }],
    ['search', { $regex: '.*' }],
    ['page', { $gt: 0 }],
    ['limit', { $eq: 1000 }],
    ['source', { $in: ['legacy', 'hydra'] }],
  ])('rejects NoSQL operator object on %s', (key, value) => {
    const { status, body, nextCalled } = runMiddleware({ [key]: value });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'BAD_INPUT',
    });
    expect(body.message).toContain(key);
    expect(nextCalled).toBe(false);
  });

  test.each([
    ['status', ['live', 'closed']],
    ['search', ['alice', 'bob']],
    ['voterType', ['drep', 'pool']],
  ])('rejects duplicate-param array on %s', (key, value) => {
    const { status, nextCalled } = runMiddleware({ [key]: value });
    expect(status).toBe(400);
    expect(nextCalled).toBe(false);
  });

  test('passes legitimate string scalars through', () => {
    const { status, nextCalled } = runMiddleware({
      status: 'live',
      voterType: 'drep',
      search: 'treasury',
      page: '1',
      limit: '10',
    });
    expect(status).toBe(null);
    expect(nextCalled).toBe(true);
  });

  test("leaves the v1 facet adapter's nested filter object alone", () => {
    // `filter` is NOT in the scalar key set — the facet adapter relies
    // on `?filter[key]=value` parsing into a nested object via the
    // extended parser. Scalar `sort` (string) is still accepted.
    const { status, nextCalled } = runMiddleware({
      filter: { categoryA: 'x' },
      sort: 'votes',
      page: '1',
    });
    expect(status).toBe(null);
    expect(nextCalled).toBe(true);
  });

  test('permits null and missing values', () => {
    const { nextCalled } = runMiddleware({ status: null });
    expect(nextCalled).toBe(true);
  });
});
