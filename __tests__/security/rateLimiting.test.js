// Regression coverage for the router-level rate limiters added so that
// CodeQL's js/missing-rate-limiting query — which can't trace a limiter
// mounted once in server.js through the dynamic per-file router loader
// (helper/loadRoutes.js) — can see a limiter directly in the same file
// as the route handlers it protects.
//
// Each limiter here is mounted alone on a throwaway Express app (no
// database, no full route stack) and driven past its configured `max`
// to confirm it actually trips and returns 429 with the documented
// error shape, rather than just existing in the middleware chain.

import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  dashboardLimiter,
  commentWriteLimiter,
  adminLimiter,
  adminAuthLimiter,
  apiKeyAuthLimiter,
  ogImageLimiter,
  spaLimiter,
  healthLimiter,
} from '../../helper/rateLimiters.js';

// Defaults pinned from helper/rateLimiters.js. If a default there
// changes, update this table alongside it.
const CASES = [
  { name: 'dashboardLimiter', limiter: dashboardLimiter, max: 60 },
  { name: 'commentWriteLimiter', limiter: commentWriteLimiter, max: 20 },
  { name: 'adminLimiter', limiter: adminLimiter, max: 60 },
  { name: 'adminAuthLimiter', limiter: adminAuthLimiter, max: 60 },
  { name: 'apiKeyAuthLimiter', limiter: apiKeyAuthLimiter, max: 120 },
  { name: 'ogImageLimiter', limiter: ogImageLimiter, max: 60 },
  { name: 'healthLimiter', limiter: healthLimiter, max: 300 },
];

function startTestApp(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/probe', (req, res) => res.status(200).json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('router-level rate limiters trip at their configured max (security)', () => {
  for (const { name, limiter, max } of CASES) {
    test(`${name}: first request succeeds, budget exhausts at ${max} and returns 429`, async () => {
      const server = await startTestApp(limiter);
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}/probe`;
      try {
        const first = await fetch(base);
        expect(first.status).toBe(200);

        let lastStatus = 200;
        let lastBody;
        for (let i = 1; i < max + 5; i++) {
          const res = await fetch(base);
          lastStatus = res.status;
          if (lastStatus === 429) {
            lastBody = await res.json();
            break;
          }
        }

        expect(lastStatus).toBe(429);
        expect(lastBody).toMatchObject({ status: 'error' });
        expect(typeof lastBody.message).toBe('string');
      } finally {
        await closeServer(server);
      }
    }, 20000);
  }

  test('spaLimiter: trips at its configured max (300) and returns 429', async () => {
    const server = await startTestApp(spaLimiter);
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}/probe`;
    try {
      const first = await fetch(base);
      expect(first.status).toBe(200);

      let lastStatus = 200;
      for (let i = 1; i < 305; i++) {
        const res = await fetch(base);
        lastStatus = res.status;
        if (lastStatus === 429) break;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await closeServer(server);
    }
  }, 20000);

  test('two different limiter instances keep separate buckets', async () => {
    // Several router files reuse the exact same exported singleton (e.g.
    // publicGetLimiter) deliberately, so that mounting it per-router adds
    // up to the same combined budget the old single app-wide mount gave.
    // This test guards the other half of that design: two genuinely
    // distinct instances, even with an identical config and the same
    // request source, do NOT share state. Built fresh here (rather than
    // reusing two of the CASES above) so it doesn't depend on run order
    // against those tests' already-exhausted shared singletons.
    const instanceA = rateLimit({ windowMs: 60 * 1000, max: 3 });
    const instanceB = rateLimit({ windowMs: 60 * 1000, max: 3 });
    const serverA = await startTestApp(instanceA);
    const serverB = await startTestApp(instanceB);
    try {
      const portA = serverA.address().port;
      const portB = serverB.address().port;
      // Exhaust instanceA's budget only.
      for (let i = 0; i < 3; i++) {
        await fetch(`http://127.0.0.1:${portA}/probe`);
      }
      const trippedA = await fetch(`http://127.0.0.1:${portA}/probe`);
      expect(trippedA.status).toBe(429);

      // instanceB, a separate instance with the same config, is untouched.
      const freshB = await fetch(`http://127.0.0.1:${portB}/probe`);
      expect(freshB.status).toBe(200);
    } finally {
      await closeServer(serverA);
      await closeServer(serverB);
    }
  }, 20000);
});
