---
"ekklesia-backend": minor
---

Resolve Hydra endpoints against an explicit allowlist and use the configured value for outbound requests.

`HYDRA_ALLOWED_ENDPOINTS` is a new comma-separated list of the Hydra instance origins a deployment may call. An endpoint supplied by an admin on `POST /:id/prepare`, or stamped on a ballot, now selects an entry from that list, and it is the configured entry that is used to build the outbound request rather than the supplied value. Previously the supplied value was validated and then used directly, so the string that was checked and the string that was used were assembled separately and could differ.

Deployments calling more than one Hydra instance must set `HYDRA_ALLOWED_ENDPOINTS` to the origins they already have `HYDRA_API_KEY_<SLUG>` variables for. Where it is unset, `HYDRA_DEFAULT_ENDPOINT` serves as a single-entry allowlist, so a single-instance deployment needs no change. An endpoint that is not on the list fails with `ENDPOINT_NOT_ALLOWED`; one that is on the list but has no key fails with `ENDPOINT_NOT_CONFIGURED`, which replaces the previous use of `ENDPOINT_NOT_ALLOWED` for that case.
