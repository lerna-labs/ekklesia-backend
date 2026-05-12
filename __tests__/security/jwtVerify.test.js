// Regression coverage for issue #41 parts 3 + 4.
//
// `helper/verifyToken.js` used to call `jwt.verify(token, JWT_SECRET)`
// with no algorithm pin. A token forged with `alg: "none"` (or any
// future default-rotation in jsonwebtoken) would be accepted as-is.
// The fix pins algorithms: ["HS256"] explicitly.

import jwt from "jsonwebtoken";

const SECRET = "test-secret-test-secret-test-secret-32+";

async function loadVerifyToken() {
  // verifyToken reads JWT_SECRET at call time, so we set it here and
  // re-import for a clean module copy.
  process.env.JWT_SECRET = SECRET;
  const mod = await import("../../helper/verifyToken.js");
  return mod.verifyToken;
}

describe("verifyToken algorithm pinning (security)", () => {
  test("accepts a properly-signed HS256 token", async () => {
    const verifyToken = await loadVerifyToken();
    const token = jwt.sign({ userId: "drep1xyz" }, SECRET, {
      algorithm: "HS256",
    });
    const result = verifyToken({ cookies: { token } });
    expect(result.status).toBe("success");
    expect(result.userId).toBe("drep1xyz");
  });

  test("rejects an alg:none token even if userId claim is present", async () => {
    const verifyToken = await loadVerifyToken();
    // Hand-craft an unsigned token with alg:none.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ userId: "drep1evil", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    const unsigned = `${header}.${payload}.`;

    const result = verifyToken({ cookies: { token: unsigned } });
    expect(result.status).toBe("error");
    expect(result.code).toBe(401);
  });

  test("rejects a token signed with the wrong algorithm name in header", async () => {
    const verifyToken = await loadVerifyToken();
    // RS256-header tokens cannot be HS256-verified against our HS256 secret.
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ userId: "drep1evil", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    const fakeSig = Buffer.from("not-a-real-signature").toString("base64url");
    const token = `${header}.${payload}.${fakeSig}`;

    const result = verifyToken({ cookies: { token } });
    expect(result.status).toBe("error");
    expect(result.code).toBe(401);
  });
});
