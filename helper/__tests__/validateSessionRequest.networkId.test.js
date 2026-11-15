// The multisig wrong-network precheck in validateSessionRequest reads the
// networkId that getAddressType derives from a stake script's header byte.
// getAddressType is not mocked here, so this fails if that field goes away.

import { jest } from '@jest/globals';
import { bech32 } from 'bech32';

await jest.unstable_mockModule('../../schema/Ballot.js', () => ({ Ballot: {} }));
await jest.unstable_mockModule('../../schema/Question.js', () => ({ Question: {} }));
await jest.unstable_mockModule('../../schema/Transaction.js', () => ({ Transaction: {} }));
await jest.unstable_mockModule('../verifyToken.js', () => ({ verifyToken: () => ({}) }));
await jest.unstable_mockModule('../idResolver.js', () => ({
  resolveBallot: jest.fn(),
  resolveProposal: jest.fn(),
}));

const { validateSessionRequest } = await import('../middleWare.js');

const encode = (prefix, hex) => bech32.encode(prefix, bech32.toWords(Buffer.from(hex, 'hex')), 256);
const STAKE_SCRIPT_TESTNET = encode('stake_test', `f0${'cd'.repeat(28)}`);
const STAKE_SCRIPT_MAINNET = encode('stake', `f1${'cd'.repeat(28)}`);

function mkRes() {
  return {
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
}

const request = (scriptAddress) => ({
  body: { signerAddress: 'addr_test1qq...whatever', signType: 'addr', scriptAddress },
});

const ORIGINAL_NETWORK_ID = process.env.NETWORK_ID;
afterEach(() => {
  if (ORIGINAL_NETWORK_ID === undefined) delete process.env.NETWORK_ID;
  else process.env.NETWORK_ID = ORIGINAL_NETWORK_ID;
});

describe('validateSessionRequest wrong-network precheck, real getAddressType', () => {
  test('a mainnet stake script is rejected on a preprod deployment', () => {
    process.env.NETWORK_ID = '0';
    const res = mkRes();
    const next = jest.fn();
    validateSessionRequest(request(STAKE_SCRIPT_MAINNET), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/wrong network/);
    expect(res.body.message).toContain('address network id 1');
  });

  test('a testnet stake script is rejected on a mainnet deployment', () => {
    process.env.NETWORK_ID = '1';
    const res = mkRes();
    const next = jest.fn();
    validateSessionRequest(request(STAKE_SCRIPT_TESTNET), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('address network id 0');
  });

  test('a stake script for the configured network passes', () => {
    process.env.NETWORK_ID = '0';
    const res = mkRes();
    const next = jest.fn();
    validateSessionRequest(request(STAKE_SCRIPT_TESTNET), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});
