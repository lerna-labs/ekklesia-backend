// Regression coverage for issue #138.
//
// Admin access has exactly one mechanism: the token's userId must be on
// the ADMIN_USER_IDS allowlist. A `role` claim on the token grants
// nothing, whether or not verifyToken happens to pass one through.
// These tests pin that a `role: "admin"` claim on a non-allowlisted
// userId is rejected, so a future change to verifyToken.js can't
// silently reopen the dead branch this fix removed.

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-test-secret-test-secret-32+';
const ADMIN_ID = 'drep1admin000000000000000000000000000000000000000000';
const OTHER_ID = 'drep1voter000000000000000000000000000000000000000000';

function mkRes() {
  const res = {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function sign(payload) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

async function loadAdminAuth() {
  // Both modules read JWT_SECRET / ADMIN_USER_IDS from process.env at
  // call time, so setting env before a fresh import is enough: there is
  // no module-level caching to work around.
  process.env.JWT_SECRET = SECRET;
  process.env.ADMIN_USER_IDS = ADMIN_ID;
  const mod = await import('../adminAuth.js');
  return mod;
}

describe('userIsAdmin', () => {
  test('grants a userId on the ADMIN_USER_IDS allowlist', async () => {
    const { userIsAdmin } = await loadAdminAuth();
    expect(userIsAdmin({ userId: ADMIN_ID })).toBe(true);
  });

  test('rejects a userId not on the allowlist', async () => {
    const { userIsAdmin } = await loadAdminAuth();
    expect(userIsAdmin({ userId: OTHER_ID })).toBe(false);
  });

  test('a role claim does not substitute for allowlist membership', async () => {
    const { userIsAdmin } = await loadAdminAuth();
    expect(userIsAdmin({ userId: OTHER_ID, role: 'admin' })).toBe(false);
  });
});

describe('isAdmin middleware', () => {
  test('allows an allowlisted userId through', async () => {
    const { isAdmin } = await loadAdminAuth();
    const token = sign({ userId: ADMIN_ID });
    const req = { cookies: { token } };
    const res = mkRes();
    const next = jest.fn();
    isAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toEqual({ userId: ADMIN_ID, role: 'admin-allowlist' });
    expect(res.statusCode).toBeNull();
  });

  test('rejects a non-allowlisted userId with role: "admin" on the token', async () => {
    const { isAdmin } = await loadAdminAuth();
    const token = sign({ userId: OTHER_ID, role: 'admin' });
    const req = { cookies: { token } };
    const res = mkRes();
    const next = jest.fn();
    isAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ status: 'error', message: 'Admin privileges required' });
  });

  test('rejects a non-allowlisted userId with no claim at all', async () => {
    const { isAdmin } = await loadAdminAuth();
    const token = sign({ userId: OTHER_ID });
    const req = { cookies: { token } };
    const res = mkRes();
    const next = jest.fn();
    isAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
