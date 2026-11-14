import { getWalletSignerConfig, SIGNER_TYPES } from '../walletSigner.js';

describe('getWalletSignerConfig', () => {
  test('defaults list every accepted type, stake as default, multisig on', () => {
    expect(getWalletSignerConfig({})).toEqual({
      userTypes: ['drep', 'stake', 'pool', 'addr'],
      userDefault: 'stake',
      multisig: true,
    });
    expect(SIGNER_TYPES).toEqual(['drep', 'stake', 'pool', 'addr']);
  });

  test('reads the three settings', () => {
    expect(
      getWalletSignerConfig({
        WALLETSIGNER_USER_TYPES: ' drep , pool,pool ',
        WALLETSIGNER_USER_DEFAULT: 'pool',
        WALLETSIGNER_MULTISIG: 'FALSE',
      }),
    ).toEqual({ userTypes: ['drep', 'pool'], userDefault: 'pool', multisig: false });
  });

  test('an unknown type names the value', () => {
    expect(() => getWalletSignerConfig({ WALLETSIGNER_USER_TYPES: 'stake,calidus' })).toThrow(
      /unknown signer type "calidus"/,
    );
  });

  test('a default outside the list names the value', () => {
    expect(() =>
      getWalletSignerConfig({
        WALLETSIGNER_USER_TYPES: 'drep,pool',
        WALLETSIGNER_USER_DEFAULT: 'stake',
      }),
    ).toThrow(/WALLETSIGNER_USER_DEFAULT "stake" is not in WALLETSIGNER_USER_TYPES/);
  });

  test('a non-boolean multisig value names the value', () => {
    expect(() => getWalletSignerConfig({ WALLETSIGNER_MULTISIG: 'yes' })).toThrow(/"yes"/);
  });
});
