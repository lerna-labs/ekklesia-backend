# Ballot Audit — Verifying Proposal Content Against On-Chain Commitments

Ekklesia ballots commit a per-proposal content hash on-chain via Hydra.
Anyone — years from now, with nothing more than a Cardano node and this
document — can reconstruct the ballot as voters saw it and
cryptographically prove it hasn't drifted.

## Chain of custody

```
Cardano L1
  └─ (600) ballot-instance token datum
       └─ ekklesia.merkleRoot                  (blake2b_256 over pinned ballot JSON)
            └─ IPFS-pinned ballot JSON          (via ballot.hydra.ballotCid)
                 └─ questions[].contentHash     (blake2b_256 per proposal)
                      └─ per-proposal content   (via GET /api/v1/ballots/:id/questions/:qid/content)
```

Every hop is an independent hash comparison. A single mismatch anywhere
breaks the chain and signals tampering.

## Three audit paths

### 1. Single proposal

```bash
# Fetch the canonical content bytes for one proposal.
curl -o content.json \
  https://<backend>/api/v1/ballots/<ballotId>/questions/<proposalId>/content

# Recompute the hash.
blake2b_256 content.json   # → hex digest

# Compare to Proposal.contentHash stamped in the DB or in the ballot's
# archive bundle manifest.
```

### 2. Full archive bundle

```bash
# Download the full ballot archive (one JSON file, self-describing).
curl -o ballot-archive.json \
  https://<backend>/api/v1/ballots/<ballotId>/archive

# The bundle carries:
#   - ballot: summary of voter-facing ballot fields
#   - proposals: { <proposalId>: { content blob } }
#   - manifest: per-file {path, bytes, blake2b_256, sha256}
#   - readme: this verification recipe (short form)
```

Verify every proposal in one pass:

```bash
jq -c '.proposals | to_entries[] | {id: .key, blob: .value}' ballot-archive.json |
  while read row; do
    id=$(echo "$row" | jq -r .id)
    echo "$row" | jq -c .blob | canonicalize | blake2b_256
    # compare against .manifest[] where path == "proposals/<id>.json"
  done
```

`canonicalize` here means the deterministic-serialization rules below.

### 3. End-to-end against on-chain

1. Query the (600) ballot-instance token's datum via a Cardano indexer
   (Koios, db-sync, Blockfrost). Extract the `BallotInstanceDatum`
   record; it carries `ekklesia.merkleRoot` (see Hydra's
   `types.ts` for datum layout).
2. Fetch the ballot JSON from IPFS via `ballot.hydra.ballotCid` (also
   present in the archive bundle and the `/api/v1/ballots/:id`
   response). Canonicalize, blake2b_256 — must equal the on-chain
   `ekklesia.merkleRoot`.
3. That IPFS-pinned ballot JSON's `questions[].contentHash` fields
   must match the per-proposal blake2b_256 hashes from the
   archive bundle manifest.
4. Each per-proposal content blob, re-hashed, must match its
   `contentHash`.

## Canonicalization rules

These rules are deterministic: the same logical JSON object produces
byte-identical output forever.

- **Encoding:** UTF-8.
- **Object keys:** sorted lexicographically (UTF-16 code-unit order,
  matching default `Array.sort()`).
- **Whitespace:** none between tokens. `{"a":1,"b":2}`, not
  `{ "a": 1, "b": 2 }`.
- **Numbers:** integers emit as digits with no decimals, no scientific
  notation, no leading zeros. Content hashes never contain floats —
  stick to integer-only fields.
- **Null vs. absent:** explicitly-null values emit as `null`; absent
  fields are omitted. These are distinct — `{"x":null}` and `{}`
  produce different bytes and different hashes.
- **Arrays:** preserve insertion order. Relevant for `options[]`
  (voter-visible order matters) and `authors[]`.
- **Strings:** standard JSON string escaping (`"`, `\`, control
  characters via `\u00XX`, non-BMP as surrogate pairs).

Reference implementation: `helper/canonicalJson.js` in this repo. The
same canonicalization is used for voter-signed vote payloads, so the
ruleset has been exercised end-to-end.

## Hash function

`blake2b_256` — Blake2b with a 32-byte (256-bit) digest, no key, no
salt, no personalization. Output encoded as lowercase hexadecimal.

Most languages have a library: Node's `blakejs`, Python's
`hashlib.blake2b(digest_size=32)`, Rust's `blake2` crate, etc.

Reference: the `blake2b256Hex` helper inside `helper/proposalContent.js`
in this repo — thin wrapper around `blake.blake2b(bytes, null, 32)`.

## Content-blob shape

```jsonc
{
  "schemaVersion": "1",
  "proposalId": "stable id",
  "title": "…",
  "summary": "…",
  "rationale": "…",
  "authors": ["…"],
  "version": "v1.0",
  "method": "choice",
  "voteRules": {
    "requireAnswer": false,
    "minSelections": 1,
    "maxSelections": 1
    // method-specific additional fields when relevant
  },
  "options": [
    {
      "id": 1,
      "label": "…",
      "cost": 1,
      "description": "…",
      "referenceUrl": "…",
      "imageUrl": "…",
      "metadata": { /* ballot-specific one-offs */ }
    }
  ],
  "parent": {
    "ballotId": "…",
    "ballotTitle": "…",
    "ballotCid": "bafy…",
    "ekklesiaMerkleRoot": "hex"
  },
  "externalProposalRef": {
    "moduleId": "…",
    "externalProposalId": "…",
    "url": "…"
  }
}
```

The `parent` back-link lets a single proposal blob stand alone: given
only the blob, you know which on-chain ballot it's committed to, and
you can walk the chain of custody independently.

## Permanence

This backend exposes the content via HTTP and (when enabled) pins to
IPFS. Long-term durability beyond our uptime is covered by:

- **IPFS** — once pinned, any IPFS gateway resolves the same CID. If
  our pinning subscription lapses, anyone who downloaded the archive
  bundle can re-pin it themselves; the CID is content-addressable and
  stable.
- **Third-party archival** — any auditor can save `ballot-archive.json`
  to their own storage / version control / chain-of-custody ledger.

See `.claude/plans/ballot-content-permanence.md` for the full
permanence plan, including optional Arweave (pay-once, stored
"forever") and Filecoin (bounded, renewable) bolt-on tracks.

## Out of scope

- **Voting-authority adjustment documents** — if the authority
  publishes a post-hoc signed doc that revises the tally (e.g.,
  disqualifying specific voters after finalize), that has its own
  chain-of-custody story referencing the same on-chain `resultsHash`.
  It does not invalidate this ballot-content commitment.
- **Ballot metadata not shown to voters** — facets, UI filter config,
  backend `data.*` annotations. These aren't committed; drift there
  doesn't affect tally integrity.
- **Upstream proposals module provenance** — the
  `externalProposalRef` field is informational. Even if an upstream
  module disappears or alters its own content, our commitment is to
  the snapshot we captured at ballot-prepare time (what voters
  actually saw).

## References

- Hydra ballot types: `~/ekklesia/hydra/src/types.ts`
  (`BallotDefinition`, `BallotQuestion`, `BallotInstanceDatum`).
- Canonicalization: `helper/canonicalJson.js`.
- Per-proposal content helper: `helper/proposalContent.js`.
- Endpoints: `routes/api/v1/ballots.js`
  (`/:id/questions/:qid/content`, `/:id/archive`).
- Permanence plan: `.claude/plans/ballot-content-permanence.md`.
- Hydra upstream TRD (contentHash field ask):
  `.claude/trds/HYDRA_PROPOSAL_CONTENT_HASH.md`.
