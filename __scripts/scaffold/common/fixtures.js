// Deterministic voter fixtures used by seedVoters.js and the scaffolded
// ballots. Real-preprod DRep/pool/stake IDs pulled from
// ~/ekklesia/docs/__tests/keys/ so the same voters work for local smoke
// tests and for preprod Hydra E2E.
//
// Multisig DRep fixture is *synthetic* — the native script + cosigner set
// mirrors the shape the broker will see; full signing-key material is
// generated in Phase 3 E2E when we need real signatures.

export const VOTERS = [
  {
    // drep01 from ~/ekklesia/docs/__tests/keys/drep01
    userId: "drep1ytdnkw2l4q7uy2d7d7sj9fhgsun56zg2uleqlfqx2lvcc6gusnw9c",
    name: "Scaffold DRep 01",
    voterGroup: "drep",
    votingPower: 1000,
    validated: true,
    kind: "key",
  },
  {
    // pool01 from ~/ekklesia/docs/__tests/keys/pool01
    userId: "pool1hqs67wez4js9899k2kcgd8hv6l3aw24mkucaeuklc58tstglsa7",
    name: "Scaffold SPO 01",
    voterGroup: "pool",
    votingPower: 5000,
    validated: true,
    kind: "key",
  },
  {
    // Placeholder stake voter — real stake key will be generated alongside
    // stake01 when needed for COSE-signing tests.
    userId: "stake_test1uq7s0crsqzp7qnltc8nu2w9lpv8xqpxyvxgjncgnqlwg8yswk2msf",
    name: "Scaffold Stakeholder 01",
    voterGroup: "default",
    votingPower: 250,
    validated: true,
    kind: "key",
  },
  {
    // Synthetic multisig DRep: 2-of-3 native script. Signing keys are
    // generated in Phase 3 E2E; the fixture carries the script topology
    // so multisigCollector can be exercised in isolation.
    userId: "drep1y-multisig-fixture-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Scaffold Multisig DRep",
    voterGroup: "drep",
    votingPower: 2500,
    validated: true,
    kind: "script",
    nativeScript: {
      type: "atLeast",
      required: 2,
      scripts: [
        { type: "sig", keyHash: "aa".repeat(28) },
        { type: "sig", keyHash: "bb".repeat(28) },
        { type: "sig", keyHash: "cc".repeat(28) },
      ],
    },
  },
];
