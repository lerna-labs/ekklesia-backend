import request from 'supertest';
import { buildApp, mintToken } from '../test-support/adminApp.js';

const { default: meRouter } = await import('../routes/api/v1/admin/me.js');

const SECRET = 'smoke-test-secret-at-least-32-characters-long';
const ADMIN_ID = 'addr_test1admin';
const app = buildApp((a) => a.use('/api/v1/admin/me', meRouter));

describe('admin routes over HTTP', () => {
  let saved;

  beforeEach(() => {
    saved = { JWT_SECRET: process.env.JWT_SECRET, ADMIN_USER_IDS: process.env.ADMIN_USER_IDS };
    process.env.JWT_SECRET = SECRET;
    process.env.ADMIN_USER_IDS = ADMIN_ID;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).get('/api/v1/admin/me');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a valid token whose id is not allowlisted', async () => {
    const token = mintToken({ userId: 'addr_test1other', secret: SECRET });
    const res = await request(app).get('/api/v1/admin/me').set('Cookie', `token=${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with the user id for an allowlisted id', async () => {
    const token = mintToken({ userId: ADMIN_ID, secret: SECRET });
    const res = await request(app).get('/api/v1/admin/me').set('Cookie', `token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(ADMIN_ID);
  });
});
