// Regression coverage for code-scanning alert #1
// (js/insecure-helmet-configuration).
//
// server.js used to mount helmet with `contentSecurityPolicy: false`,
// which disables the CSP header entirely. helper/securityHeaders.js now
// enables CSP on top of helmet's secure defaults with two SPA-specific
// additions (inline bootstrap script, arbitrary-host proposal images).
// This exercises the exact middleware mounted in server.js against a
// live HTTP request rather than re-asserting a copy of the config.

import express from 'express';
import { securityHeaders } from '../../helper/securityHeaders.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  // Mirrors the exact mounting order in server.js.
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.get('/', (req, res) => res.send('ok'));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('helmet configuration (security)', () => {
  test('Content-Security-Policy is present and does not disable itself', async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    // The alert fires specifically when contentSecurityPolicy is `false`;
    // a header being present at all is the primary regression guard.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  test('script-src keeps the SPA bootstrap script working without opening object-src', async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
  });

  test('img-src allows admin-supplied proposal image hosts', async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("img-src 'self' data: https:");
  });

  test('frame protection stays enabled (clickjacking)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'self'");
  });

  test('X-Powered-By is not disclosed', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
