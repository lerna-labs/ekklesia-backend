---
"ekklesia-backend": patch
---

Remove the request to the Hydra middleware's `/register` endpoint that was sent on every voter and multisig login. The request never succeeded: it sent `userId` where the middleware reads `voterId`, and the helper read the response from a variable that was never assigned. Voters are registered in the head on their first vote, so login behavior is unchanged.
