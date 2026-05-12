// Regression coverage for issue #51.
//
// `helper/rateLimiters.js` used to call `ipKeyGenerator(req, res)` in
// every IP-fallback keyGenerator. In express-rate-limit v8 the helper
// signature is `ipKeyGenerator(ip: string)`. Given the wrong shape it
// silently returns its first argument verbatim — meaning each request
// becomes a fresh bucket (MemoryStore keys by object identity), the
// counter never accumulates, and the limiter never trips.
//
// These tests pin the invariant directly on the exported keyGenerator
// helpers so the next reader who "simplifies" them back to `(req, res)`
// trips a red CI before the regression ships.

import { ipKeyGenerator } from "express-rate-limit";
import {
  ipFallbackKey,
  userOrIpKey,
  importerOrIpKey,
  apiKeyOrIpKey,
} from "../../helper/rateLimiters.js";

describe("ipKeyGenerator v8 signature (security)", () => {
  test("returns a string when given an IP string", () => {
    expect(typeof ipKeyGenerator("127.0.0.1")).toBe("string");
    expect(typeof ipKeyGenerator("::1")).toBe("string");
  });

  test("collapses repeated calls with the same IP to the same key", () => {
    expect(ipKeyGenerator("127.0.0.1")).toBe(ipKeyGenerator("127.0.0.1"));
    expect(ipKeyGenerator("::1")).toBe(ipKeyGenerator("::1"));
  });

  test("the buggy v7-style call shape returns a non-string (object identity)", () => {
    // This is the actual root cause — when the v7 shape leaks in, the
    // bucket key becomes the `req` object itself, which is unique per
    // request. Asserting the shape here is intentional: if a future
    // express-rate-limit release ever starts coercing the wrong shape
    // into a string, our keyGenerator code would still be technically
    // correct (it uses req.ip) but the safety net here would relax.
    const fakeReq = { ip: "127.0.0.1" };
    expect(typeof ipKeyGenerator(fakeReq, {})).not.toBe("string");
  });
});

describe("rateLimiters keyGenerator helpers (security)", () => {
  function fakeReq({ ip = "127.0.0.1", auth, apiKey } = {}) {
    return { ip, auth, apiKey };
  }

  describe("ipFallbackKey", () => {
    test("returns a string", () => {
      expect(typeof ipFallbackKey(fakeReq())).toBe("string");
    });
    test("two fresh req objects with the same IP get the same key", () => {
      expect(ipFallbackKey(fakeReq({ ip: "::1" }))).toBe(
        ipFallbackKey(fakeReq({ ip: "::1" }))
      );
    });
    test("different IPs bucket separately", () => {
      expect(ipFallbackKey(fakeReq({ ip: "1.2.3.4" }))).not.toBe(
        ipFallbackKey(fakeReq({ ip: "5.6.7.8" }))
      );
    });
  });

  describe("userOrIpKey", () => {
    test("returns the userId when authenticated", () => {
      expect(userOrIpKey(fakeReq({ auth: { userId: "drep1xyz" } }))).toBe(
        "drep1xyz"
      );
    });
    test("falls back to a stable IP-derived string when anonymous", () => {
      const a = userOrIpKey(fakeReq({ ip: "::1" }));
      const b = userOrIpKey(fakeReq({ ip: "::1" }));
      expect(typeof a).toBe("string");
      expect(a).toBe(b);
    });
    test("two voters sharing an IP get separate buckets", () => {
      expect(
        userOrIpKey(fakeReq({ ip: "::1", auth: { userId: "drep1aaa" } }))
      ).not.toBe(
        userOrIpKey(fakeReq({ ip: "::1", auth: { userId: "drep1bbb" } }))
      );
    });
  });

  describe("importerOrIpKey", () => {
    test("prefers req.auth.id over userId", () => {
      expect(
        importerOrIpKey(
          fakeReq({ auth: { id: "key-123", userId: "drep1xyz" } })
        )
      ).toBe("key-123");
    });
    test("falls back to userId then to a stable IP string", () => {
      expect(
        importerOrIpKey(fakeReq({ auth: { userId: "drep1xyz" } }))
      ).toBe("drep1xyz");
      const a = importerOrIpKey(fakeReq({ ip: "1.1.1.1" }));
      const b = importerOrIpKey(fakeReq({ ip: "1.1.1.1" }));
      expect(typeof a).toBe("string");
      expect(a).toBe(b);
    });
  });

  describe("apiKeyOrIpKey", () => {
    test("returns the API key id when valid", () => {
      expect(apiKeyOrIpKey(fakeReq({ apiKey: { id: "ak_abc" } }))).toBe(
        "ak_abc"
      );
    });
    test("falls back to a stable IP string for missing/invalid keys", () => {
      const a = apiKeyOrIpKey(fakeReq({ ip: "10.0.0.1" }));
      const b = apiKeyOrIpKey(fakeReq({ ip: "10.0.0.1" }));
      expect(typeof a).toBe("string");
      expect(a).toBe(b);
    });
  });
});
