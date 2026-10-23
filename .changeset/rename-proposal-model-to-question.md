---
'ekklesia-backend': patch
---

Rename the internal Mongoose model for ballot questions from `Proposal` to `Question`. It stays pinned to the existing `proposals` collection, so stored data, field names and API responses are unchanged.
