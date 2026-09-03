// Regression coverage for CodeQL alerts #3, #4, #5
// (js/type-confusion-through-parameter-tampering).
//
// A repeated query key (?search=a&search=b) lands as an array in
// req.query.search. Each of these three list routes used to call a
// string method on `search` directly, which threw and surfaced as a
// 500 rather than a clean validation error. Each route now guards on
// `typeof search !== 'string'` before touching it.
//
// The database layer is stubbed so these run as fast, deterministic
// unit tests: the guard itself never reaches the database, and the
// legitimate-search assertions only need to prove the guard doesn't
// fire, not exercise real aggregation results.

import { jest } from '@jest/globals';

// GET /api/v1/public/ballots sits behind requireApiKey/requireScope.
// That gate is orthogonal to the search-parameter guard under test, so
// it's stubbed out rather than standing up a real ApiKey/Mongo lookup.
await jest.unstable_mockModule('../../helper/apiKeyAuth.js', () => ({
  requireApiKey: (req, res, next) => {
    req.apiKey = { id: 'test-key', scopes: ['read:ballots'] };
    next();
  },
  requireScope: () => (req, res, next) => next(),
}));

// Both ballots routers list through this adapter dispatcher. Stubbed so
// the "legitimate search still works" assertions don't depend on a
// live MongoDB.
await jest.unstable_mockModule('../../helper/ballotAdapters/index.js', () => ({
  listUnified: jest.fn().mockResolvedValue({
    items: [],
    pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
  }),
  getUnified: jest.fn().mockResolvedValue(null),
}));

const { default: express } = await import('express');
const { Vote } = await import('../../schema/Vote.js');
const { default: publicBallotsRouter } = await import('../../routes/api/v1/public/ballots.js');
const { default: ballotsRouter } = await import('../../routes/api/v1/ballots.js');
const { default: votersRouter } = await import('../../routes/api/v0/voters.js');

// The voters directory list aggregates directly against the Vote
// collection rather than going through the adapter dispatcher.
jest.spyOn(Vote, 'aggregate').mockResolvedValue([]);

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/public-ballots', publicBallotsRouter);
  app.use('/ballots', ballotsRouter);
  app.use('/voters', votersRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('repeated ?search query key (search-param type confusion)', () => {
  test('alert #4 — GET /api/v1/public/ballots rejects a duplicated search key with 400', async () => {
    const res = await fetch(`${baseUrl}/public-ballots?search=a&search=b`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
  });

  test('alert #3 — GET /api/v0/voters rejects a duplicated search key with 400', async () => {
    const res = await fetch(`${baseUrl}/voters?search=a&search=b`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
  });

  test('alert #5 — GET /api/v1/ballots rejects a duplicated search key with 400', async () => {
    const res = await fetch(`${baseUrl}/ballots?search=a&search=b`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
  });

  test('a single-string search value still passes the guard on all three routes', async () => {
    const publicRes = await fetch(`${baseUrl}/public-ballots?search=treasury`);
    expect(publicRes.status).toBe(200);

    const votersRes = await fetch(`${baseUrl}/voters?search=treasury`);
    expect(votersRes.status).toBe(200);

    const ballotsRes = await fetch(`${baseUrl}/ballots?search=treasury`);
    expect(ballotsRes.status).toBe(200);
  });
});
