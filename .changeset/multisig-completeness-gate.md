---
"ekklesia-backend": patch
---

Fix `PUT /api/v0/dashboard/:ballotId/checkout/multisig` treating a chain data provider failure as a complete multisig. `validateScriptSignatures` returns either a boolean or an `{ error }` object, and the route tested the result with `if (!multisigComplete)`, which is false for any object, including an error one, so a failed signature-completeness check fell through into the branch that finalizes votes. The route now requires the result to be strictly `true` before treating the multisig as complete, and returns a 502 without changing the transaction's status when the check itself fails, instead of the previous 200 `pending` response that recorded a provider outage as a genuine incomplete multisig.
