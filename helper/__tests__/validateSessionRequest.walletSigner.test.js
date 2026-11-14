// Verifies the WALLETSIGNER_* settings are enforced by validateSessionRequest
// with a 403, and that unset settings change nothing.

import { jest } from '@jest/globals';

const DREP_SCRIPT = 'drep1yvtqft3982fwrxaw5p5phd3xnwls0nc3tqdp68kgw8zvu6qn73kqt';
const DREP_ID = 'drep1ygkeyidfortest';
const DREP_105 = 'drep1cip105fortest';
const STAKE_ID = 'stake_test1ufortest';

const ADDR_TYPES = {
  [DREP_SCRIPT]: { type: 'drep', keyHash: 'ab'.repeat(28), hashType: 'script', networkId: null },
};

await jest.unstable_mockModule('../../schema/Ballot.js', () => ({ Ballot: {} }));
await jest.unstable_mockModule('../../schema/Question.js', () => ({ Question: {} }));
await jest.unstable_mockModule('../../schema/Transaction.js', () => ({ Transaction: {} }));
await jest.unstable_mockModule('../verifyToken.js', () => ({ verifyToken: () => ({}) }));
await jest.unstable_mockModule('../idResolver.js', () => ({
  resolveBallot: jest.fn(),
  resolveProposal: jest.fn(),
}));
await jest.unstable_mockModule('../validateAddress.js', () => ({
  validateAddress: (addr) =>
    addr === DREP_105 ? { cip105: DREP_105, cip129: 'drep1cip129fortest', isScript: false } : addr,
  getAddressType: (addr) => ADDR_TYPES[addr] || { error: 'Not a valid bech32 address' },
}));
await jest.unstable_mockModule('@emurgo/cardano-serialization-lib-nodejs', () => ({
  PublicKey: {},
}));

const { validateSessionRequest } = await import('../middleWare.js');

function run(body) {
  const req = { body };
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
  const next = jest.fn();
  validateSessionRequest(req, res, next);
  return { req, res, next };
}

const ENV_KEYS = ['WALLETSIGNER_USER_TYPES', 'WALLETSIGNER_USER_DEFAULT', 'WALLETSIGNER_MULTISIG'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NETWORK_ID = '0';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const drepLogin = { signerAddress: DREP_ID, signType: 'drep' };
const stakeLogin = { signerAddress: STAKE_ID, signType: 'stake' };
const multisigLogin = {
  signerAddress: 'addr_test1qq',
  signType: 'addr',
  scriptAddress: DREP_SCRIPT,
};

describe('validateSessionRequest wallet signer settings', () => {
  test('with none set, drep, stake, pool and multisig logins pass', () => {
    expect(run(drepLogin).next).toHaveBeenCalled();
    expect(run(stakeLogin).next).toHaveBeenCalled();
    expect(run({ signerAddress: 'pool1x', signType: 'pool' }).next).toHaveBeenCalled();
    expect(run(multisigLogin).next).toHaveBeenCalled();
  });

  test('WALLETSIGNER_USER_TYPES=stake gives a drep login a 403 and lets stake through', () => {
    process.env.WALLETSIGNER_USER_TYPES = 'stake';
    const denied = run(drepLogin);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body.message).toMatch(/"drep"/);
    expect(denied.next).not.toHaveBeenCalled();
    expect(run(stakeLogin).next).toHaveBeenCalled();
  });

  test('WALLETSIGNER_USER_TYPES=stake,addr also refuses a drep script multisig', () => {
    process.env.WALLETSIGNER_USER_TYPES = 'stake,addr';
    expect(run(multisigLogin).res.statusCode).toBe(403);
  });

  test('WALLETSIGNER_MULTISIG=false gives a multisig login a 403 and leaves standalone logins', () => {
    process.env.WALLETSIGNER_MULTISIG = 'false';
    const denied = run(multisigLogin);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body.message).toMatch(/Multisig/);
    expect(denied.next).not.toHaveBeenCalled();
    expect(run(stakeLogin).next).toHaveBeenCalled();
  });

  test('a multisig login signed with a payment key needs addr in the list', () => {
    process.env.WALLETSIGNER_USER_TYPES = 'drep,stake,pool';
    const denied = run(multisigLogin);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body.message).toMatch(/"addr"/);
    expect(run({ ...multisigLogin, signType: 'addr_test' }).res.statusCode).toBe(403);
    expect(run({ ...multisigLogin, signType: 'drep' }).next).toHaveBeenCalled();
    process.env.WALLETSIGNER_USER_TYPES = 'stake,drep,addr';
    expect(run(multisigLogin).next).toHaveBeenCalled();
  });

  test('a CIP-105 DRep ID keeps its 400 when drep is disabled', () => {
    process.env.WALLETSIGNER_USER_TYPES = 'stake';
    const { res } = run({ signerAddress: DREP_105, signType: 'drep' });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/CIP129/);
  });

  test('a payment-address login keeps its 400 whatever the list says', () => {
    process.env.WALLETSIGNER_USER_TYPES = 'stake';
    expect(run({ signerAddress: 'addr_test1qq', signType: 'addr' }).res.statusCode).toBe(400);
  });
});
