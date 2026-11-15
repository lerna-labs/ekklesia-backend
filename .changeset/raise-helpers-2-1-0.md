---
"ekklesia-backend": patch
---

Raise `@lerna-labs/ekklesia-helpers` to `^2.1.0`. Chain data provider failures on the login and checkout signature routes (standard login, multisig login, checkout signing, multisig checkout signing) now answer 503 with a fixed generic message instead of 400, 403 or 500, and the provider's own message is kept in the server log. A rejected provider credential also logs an error line tagged `ALERT:PROVIDER_CREDENTIAL_REJECTED`, and a throttling response passes the provider's retry delay through on `Retry-After` when one is given. The server now exits with status 1 when a route file fails to load, instead of staying up without listening.
