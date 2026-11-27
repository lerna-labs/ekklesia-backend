// The Hydra endpoint is server-side configuration: the backend proxies every
// Hydra call, so no public ballot response may carry a ballot's endpoint.

import { jest } from '@jest/globals';
import request from 'supertest';
import { buildApp } from '../test-support/adminApp.js';

const ENDPOINT = 'http://203.0.113.7:3030';

const mocks = { resolveBallot: jest.fn() };

await jest.unstable_mockModule('../helper/idResolver.js', () => ({
  resolveBallot: (...args) => mocks.resolveBallot(...args),
  resolveProposal: jest.fn(),
}));

const { toUnified } = await import('../helper/ballotAdapters/hydraAdapter.js');
const { getBallot } = await import('../helper/middleWare.js');
const { Ballot } = await import('../schema/Ballot.js');
const { default: v0Ballots } = await import('../routes/api/v0/ballots.js');

const stored = {
  _id: '507f1f77bcf86cd799439011',
  title: 'Hydra ballot',
  status: 'live',
  voterType: 'drep',
  hydraEndpoint: ENDPOINT,
  hydraHeadId: 'head-1',
};

describe('ballot responses do not carry the Hydra endpoint', () => {
  afterEach(() => jest.restoreAllMocks());

  test('the unified ballot shape has no hydra.endpoint', () => {
    const unified = toUnified(stored);
    expect(unified.hydra).not.toHaveProperty('endpoint');
    expect(unified.hydra.headId).toBe('head-1');
    expect(JSON.stringify(unified)).not.toContain(ENDPOINT);
  });

  test('GET /api/v0/ballots list projects the endpoint out', async () => {
    jest.spyOn(Ballot, 'aggregate').mockImplementation(async (pipeline) => {
      if (pipeline.some((s) => s.$count)) return [{ total: 1 }];
      const excluded = Object.keys(pipeline.find((s) => s.$project).$project);
      return [Object.fromEntries(Object.entries(stored).filter(([k]) => !excluded.includes(k)))];
    });
    const app = buildApp((a) => a.use('/api/v0/ballots', v0Ballots));
    const res = await request(app).get('/api/v0/ballots');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(ENDPOINT);
  });

  test('getBallot does not load the endpoint onto req.ballot', async () => {
    mocks.resolveBallot.mockImplementation(async (_id, { selectFields }) => {
      const wanted = new Set(selectFields.split(/\s+/));
      const doc = Object.fromEntries(Object.entries(stored).filter(([k]) => wanted.has(k)));
      return { doc, source: 'internal' };
    });
    const req = { params: { ballotId: stored._id } };
    const res = { status: () => res, json: () => res };
    await getBallot(req, res, () => {});
    expect(req.ballot).toBeDefined();
    expect(req.ballot.hydraHeadId).toBe('head-1');
    expect(req.ballot).not.toHaveProperty('hydraEndpoint');
  });
});
