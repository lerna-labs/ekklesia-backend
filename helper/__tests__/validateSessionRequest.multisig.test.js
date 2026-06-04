// Verifies helper/middleWare.js#validateSessionRequest gating:
//   - On the multisig path (body.scriptAddress present) the signType/HRP
//     gate is skipped so a member's wallet may sign with any credential
//     (payment / stake / drep). signType is derived from the script
//     address's own credential kind (drep_script -> drep, stake_script ->
//     stake) so the voter lands in the matching group.
//   - Non-script / unsupported scriptAddress values are rejected.
//   - On the standalone path the payment-address ("addr") block still
//     applies.
//
// getAddressType is mocked with an exact-string lookup so the branching
// logic is exercised deterministically without CSL; the schema
// side-effect imports are stubbed to keep this a pure unit (no Mongo).

import { jest } from "@jest/globals";

const DREP_SCRIPT = "drep1yvtqft3982fwrxaw5p5phd3xnwls0nc3tqdp68kgw8zvu6qn73kqt";
const STAKE_SCRIPT = "stake_test17qkqjhztj5hpseht5p5phd3xnwls0nc3tqdp68kgw8zvu6qscriptt";
const STAKE_SCRIPT_MAINNET = "stake17qkqjhztj5hpseht5p5phd3xnwls0nc3tqdp68kgw8zvu6qmainnet";
const DREP_KEY = "drep1 key based — not a script";

const ADDR_TYPES = {
  [DREP_SCRIPT]: { type: "drep", keyHash: "ab".repeat(28), hashType: "script", networkId: null },
  [STAKE_SCRIPT]: { type: "stake", keyHash: "cd".repeat(28), hashType: "script", networkId: 0 },
  [STAKE_SCRIPT_MAINNET]: { type: "stake", keyHash: "cd".repeat(28), hashType: "script", networkId: 1 },
  [DREP_KEY]: { type: "drep", keyHash: "ef".repeat(28), hashType: "key", networkId: null },
};

await jest.unstable_mockModule("../../schema/Ballot.js", () => ({ Ballot: {} }));
await jest.unstable_mockModule("../../schema/Proposal.js", () => ({ Proposal: {} }));
await jest.unstable_mockModule("../../schema/Transaction.js", () => ({ Transaction: {} }));
await jest.unstable_mockModule("../verifyToken.js", () => ({ verifyToken: () => ({}) }));
await jest.unstable_mockModule("../idResolver.js", () => ({
  resolveBallot: jest.fn(),
  resolveProposal: jest.fn(),
}));
await jest.unstable_mockModule("../validateAddress.js", () => ({
  validateAddress: () => ({}),
  getAddressType: (addr) =>
    ADDR_TYPES[addr] || { error: "Not a valid bech32 address" },
}));
await jest.unstable_mockModule(
  "@emurgo/cardano-serialization-lib-nodejs",
  () => ({ PublicKey: {} })
);

const { validateSessionRequest } = await import("../middleWare.js");

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

// The stake network precheck reads process.env.NETWORK_ID at call time;
// default the suite to preprod (0) and restore between tests.
const ORIGINAL_NETWORK_ID = process.env.NETWORK_ID;
beforeEach(() => {
  process.env.NETWORK_ID = "0";
});
afterEach(() => {
  if (ORIGINAL_NETWORK_ID === undefined) delete process.env.NETWORK_ID;
  else process.env.NETWORK_ID = ORIGINAL_NETWORK_ID;
});

describe("validateSessionRequest — multisig path", () => {
  test("accepts a payment-address (addr) signature against a drep script", () => {
    const req = {
      body: {
        signerAddress: "addr_test1qq...whatever",
        signType: "addr",
        scriptAddress: DREP_SCRIPT,
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.isScript).toBe(true);
    // Identity follows the script credential, not how the wallet signed.
    expect(req.signType).toBe("drep");
    expect(req.addressBech32).toBe(DREP_SCRIPT);
  });

  test("accepts a stake-script multisig and derives signType=stake", () => {
    const req = {
      body: {
        signerAddress: "addr_test1qq...whatever",
        signType: "addr",
        scriptAddress: STAKE_SCRIPT,
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.isScript).toBe(true);
    expect(req.signType).toBe("stake");
    expect(req.addressBech32).toBe(STAKE_SCRIPT);
  });

  test("ignores the body signType in favor of the script credential kind", () => {
    const req = {
      body: {
        signerAddress: "stake_test1ur...whatever",
        signType: "stake",
        scriptAddress: DREP_SCRIPT,
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.signType).toBe("drep");
  });

  test("trims and forwards signerAddress + scriptAddress", () => {
    const req = {
      body: {
        signerAddress: "  addr_test1qq...whatever  ",
        signType: "addr",
        scriptAddress: `  ${DREP_SCRIPT}  `,
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.signerAddress).toBe("addr_test1qq...whatever");
    expect(req.addressBech32).toBe(DREP_SCRIPT);
  });

  test("rejects a key-based (non-script) address sent as scriptAddress", () => {
    const req = {
      body: {
        signerAddress: "addr_test1qq...whatever",
        signType: "drep",
        scriptAddress: DREP_KEY,
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/drep or stake script/);
  });

  test("rejects an unparseable scriptAddress", () => {
    const req = {
      body: {
        signerAddress: "addr_test1qq...whatever",
        signType: "drep",
        scriptAddress: "not-a-real-address",
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/drep or stake script/);
  });

  test("rejects a stake script whose network id doesn't match this service", () => {
    process.env.NETWORK_ID = "0"; // preprod
    const req = {
      body: {
        signerAddress: "addr1qq...whatever",
        signType: "stake",
        scriptAddress: STAKE_SCRIPT_MAINNET, // networkId 1
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/wrong network/);
  });

  test("does not enforce the network check when NETWORK_ID is unset", () => {
    delete process.env.NETWORK_ID;
    const req = {
      body: {
        signerAddress: "addr1qq...whatever",
        signType: "stake",
        scriptAddress: STAKE_SCRIPT_MAINNET, // networkId 1, but no expectation configured
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.signType).toBe("stake");
  });

  test("does not apply the network check to drep scripts (no network byte)", () => {
    process.env.NETWORK_ID = "1"; // mainnet expectation, but drep carries no network id
    const req = {
      body: {
        signerAddress: "addr1qq...whatever",
        signType: "drep",
        scriptAddress: DREP_SCRIPT, // networkId null
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.signType).toBe("drep");
  });
});

describe("validateSessionRequest — standalone path", () => {
  test("still rejects payment-address login when no scriptAddress is present", () => {
    const req = {
      body: { signerAddress: "addr_test1qq...whatever", signType: "addr" },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Payment addresses are not accepted/);
  });

  test("an empty-string scriptAddress is not treated as the multisig path", () => {
    const req = {
      body: {
        signerAddress: "addr_test1qq...whatever",
        signType: "addr",
        scriptAddress: "   ",
      },
    };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Payment addresses are not accepted/);
  });

  test("missing signerAddress is rejected before any path branch", () => {
    const req = { body: { signType: "drep", scriptAddress: DREP_SCRIPT } };
    const res = mkRes();
    const next = jest.fn();

    validateSessionRequest(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Missing signerAddress/);
  });
});
