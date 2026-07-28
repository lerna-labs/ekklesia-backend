---
"ekklesia-backend": major
---

First stable release of the Ekklesia Voting API.

The API is now published as open source under the Apache License 2.0, alongside
the rest of the Ekklesia platform. This release incorporates the changes made in
response to the independent security audit of the platform, including verified
multi-signature co-signer signatures, a whole-package signature check before a
vote package is submitted, the shared canonical JSON encoding used by every
component that publishes vote evidence, and a canonicalised signing payload so
that any implementation derives the same ballot hash for a given voter and set
of selections.

Vote evidence and results are published under protocol version ekklesia/2.0.
Ballots that settled under the previous protocol version keep their original
version string and remain verifiable exactly as they were, because the earlier
verification path is retained rather than replaced.
