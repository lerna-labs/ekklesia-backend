---
"ekklesia-backend": minor
---

Add `WALLETSIGNER_USER_TYPES`, `WALLETSIGNER_USER_DEFAULT` and `WALLETSIGNER_MULTISIG` settings. `GET /api/v1/config` returns the effective values as a `walletSigner` object (`userTypes`, `userDefault`, `multisig`), and login answers a disabled signer type, or a multisig login while multisig is off, with a 403 naming what is disabled. An unknown type, a default outside the list or a non-boolean multisig value stops startup. With none set, login accepts what it accepted before: `drep`, `stake`, `pool` and `addr`, with `stake` as the default and multisig on.
