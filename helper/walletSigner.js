// Wallet signer settings, read from the deployment's env:
//   WALLETSIGNER_USER_TYPES    comma-separated signer types login accepts
//   WALLETSIGNER_USER_DEFAULT  the type the frontend preselects
//   WALLETSIGNER_MULTISIG      true | false, whether multisig login is available
// Unset values reproduce what login accepts without any of them.

// The voter types login accepts: drep, stake and pool. Which key signs a
// multisig is decided by its script, not by this list, and `addr` is not a
// voter type. A `calidus` address cannot open a session (it validates to an
// object, which a Session userId rejects), so it is not listed.
export const SIGNER_TYPES = ['drep', 'stake', 'pool'];
const DEFAULT_USER_DEFAULT = 'stake';

/**
 * Read and validate the wallet signer settings.
 *
 * @returns {{ userTypes: string[], userDefault: string, multisig: boolean }}
 * @throws {Error} naming the offending value when a setting is invalid
 */
export function getWalletSignerConfig(env = process.env) {
  const rawTypes = (env.WALLETSIGNER_USER_TYPES ?? '').trim();
  const userTypes = rawTypes
    ? [
        ...new Set(
          rawTypes
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ]
    : [...SIGNER_TYPES];
  for (const type of userTypes) {
    if (!SIGNER_TYPES.includes(type)) {
      throw new Error(
        `WALLETSIGNER_USER_TYPES contains unknown signer type "${type}" (allowed: ${SIGNER_TYPES.join(', ')})`,
      );
    }
  }
  if (userTypes.length === 0) {
    throw new Error('WALLETSIGNER_USER_TYPES must list at least one signer type');
  }

  const userDefault = (env.WALLETSIGNER_USER_DEFAULT ?? '').trim() || DEFAULT_USER_DEFAULT;
  if (!userTypes.includes(userDefault)) {
    throw new Error(
      `WALLETSIGNER_USER_DEFAULT "${userDefault}" is not in WALLETSIGNER_USER_TYPES (${userTypes.join(', ')})`,
    );
  }

  const rawMultisig = (env.WALLETSIGNER_MULTISIG ?? '').trim().toLowerCase();
  if (rawMultisig && rawMultisig !== 'true' && rawMultisig !== 'false') {
    throw new Error(`WALLETSIGNER_MULTISIG must be "true" or "false", got "${rawMultisig}"`);
  }
  const multisig = rawMultisig !== 'false';

  return { userTypes, userDefault, multisig };
}
