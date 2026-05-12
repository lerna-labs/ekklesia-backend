// Regression coverage for issue #39.
//
// `POST /api/v1/votes/:ballotId/draft` used to accept `responderRole`
// from the request body and propagate it verbatim into the local
// VoteEvidence bundle and prelimVoteHash. After upstream commit
// `2dc0650` Hydra ignores the client-supplied value and re-derives
// `responderRole` from the voter's bech32 HRP, so the backend must
// mirror the same mapping to keep the prelim hash equal to the
// settlement hash.

import { credentialHrp, responderRoleFor } from "../../helper/voterCredential.js";

describe("responderRoleFor (security)", () => {
  test.each([
    ["drep1xyz", "drep"],
    ["pool1xyz", "pool"],
    ["calidus1xyz", "pool"],
    ["stake1xyz", "stake"],
    ["stake_test1xyz", "stake"],
  ])("derives role from credential HRP — %s → %s", (voterId, expected) => {
    expect(responderRoleFor(voterId)).toBe(expected);
  });

  test.each([
    "addr1xyz",
    "addr_test1xyz",
    "unknown1xyz",
    "",
    null,
    undefined,
  ])("rejects unsupported credential %p", (voterId) => {
    expect(responderRoleFor(voterId)).toBe(null);
  });

  test("credentialHrp still returns calidus separately from the role", () => {
    // The HRP and the role intentionally differ for calidus — the
    // evidence carries the HRP, the tally weights by role. Don't
    // collapse them; downstream code reads both.
    expect(credentialHrp("calidus1xyz")).toBe("calidus");
    expect(responderRoleFor("calidus1xyz")).toBe("pool");
  });
});
