import request from 'supertest';
import { buildApp } from '../test-support/adminApp.js';
import { securityHeaders } from '../helper/securityHeaders.js';

const app = buildApp((a) => {
  a.use(securityHeaders());
  a.get('/', (req, res) => res.send('ok'));
});

describe('Content-Security-Policy header', () => {
  it('allows the Cloudflare Web Analytics beacon script and leaves the rest of the policy unchanged', async () => {
    const res = await request(app).get('/');
    const policy = res.headers['content-security-policy'];
    const directives = Object.fromEntries(
      policy.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );

    expect(directives['script-src']).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://static.cloudflareinsights.com/beacon.min.js/',
    ]);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toBeUndefined();
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'https:']);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'self'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(directives['form-action']).toEqual(["'self'"]);
  });
});
