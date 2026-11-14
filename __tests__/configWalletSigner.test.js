import express from 'express';
import request from 'supertest';

const { default: configRouter } = await import('../routes/api/v1/config.js');

const app = express();
app.use('/api/v1/config', configRouter);

const ENV_KEYS = ['WALLETSIGNER_USER_TYPES', 'WALLETSIGNER_USER_DEFAULT', 'WALLETSIGNER_MULTISIG'];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('GET /api/v1/config walletSigner', () => {
  test('reports every accepted type, stake and multisig on when nothing is set', async () => {
    const res = await request(app).get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.walletSigner).toEqual({
      userTypes: ['drep', 'stake', 'pool'],
      userDefault: 'stake',
      multisig: true,
    });
    expect(res.body.network).toBeDefined();
  });

  test('reports the effective values from the env', async () => {
    process.env.WALLETSIGNER_USER_TYPES = 'stake,pool';
    process.env.WALLETSIGNER_USER_DEFAULT = 'pool';
    process.env.WALLETSIGNER_MULTISIG = 'false';
    const res = await request(app).get('/api/v1/config');
    expect(res.body.walletSigner).toEqual({
      userTypes: ['stake', 'pool'],
      userDefault: 'pool',
      multisig: false,
    });
  });
});
