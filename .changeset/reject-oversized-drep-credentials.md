---
"ekklesia-backend": patch
---

Sign-in no longer accepts a DRep ID whose key or script credential is not exactly 28 bytes. Previously a crafted DRep ID holding two key hashes passed address validation, and the signature check then accepted it because the credential contained the signer's key hash. Such IDs, and IDs with a shorter credential or an unknown header byte, are now rejected with an error.
