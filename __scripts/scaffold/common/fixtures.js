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
    voterGroup: "stake",
    votingPower: 250,
    validated: true,
    kind: "key",
  },
  {
    // Frontend voter-history test subject — real preprod stake credential
    // the operator logs in with to exercise "my past votes" and
    // voting-power display UX. No signing-key material bundled; scaffold
    // votes are unsigned demo data. `forceParticipate: true` bypasses
    // the seeder's random turnout draw so this voter has votes on every
    // stake-eligible ballot (closed + live). Per-proposal engagement is
    // also forced, so they vote on every question within each ballot.
    userId: "stake_test1ur97k8x2dkedxscjls0z2leux34yuz30hngsg6nylyjs7fgkxjnv2",
    name: "Frontend Test Voter",
    voterGroup: "stake",
    votingPower: 750,
    validated: true,
    kind: "key",
    forceParticipate: true,
  },
  {
    // Real 2-of-3 multisig DRep registered on preprod. Keys live at
    // ~/hydra-voter.multisig.drep.{1,2,3}.skey (and matching .vkey / .addr).
    // The native script below matches the on-chain registration. For
    // Phase 3 E2E we sign with any 2 of the 3 keys to satisfy `required`.
    userId: "drep1yvtqft3982fwrxaw5p5phd3xnwls0nc3tqdp68kgw8zvu6qn73kqt",
    name: "Scaffold Multisig DRep (real preprod)",
    voterGroup: "drep",
    votingPower: 2500,
    validated: true,
    kind: "script",
    nativeScript: {
      type: "atLeast",
      required: 2,
      scripts: [
        { type: "sig", keyHash: "48163fd5ff61896c1983ac9dcc01769bf926c11b40a669abe62ccecd" },
        { type: "sig", keyHash: "57a02df7872543b7aa0043a336255b4a8a4776d6bec483a93001df91" },
        { type: "sig", keyHash: "a7828ce917588c67174cdec44f51a7bd4cca3497499b28f686aacd41" },
      ],
    },
    // Absolute paths to the cosigner skeys (home-directory expanded at
    // runtime). castVoteMultisig.js signs with the first `required` keys
    // by default.
    keyPaths: [
      "~/hydra-voter.multisig.drep.1.skey",
      "~/hydra-voter.multisig.drep.2.skey",
      "~/hydra-voter.multisig.drep.3.skey",
    ],
  },
];

// Single-sig DRep used for Phase 3 E2E signing. The key lives in the
// docs repo test keys.
export const SINGLE_SIG_VOTER = {
  userId: "drep1ytdnkw2l4q7uy2d7d7sj9fhgsun56zg2uleqlfqx2lvcc6gusnw9c",
  voterGroup: "drep",
  votingPower: 1000,
  keyPath: "~/ekklesia/docs/__tests/keys/drep01/drep.skey",
  addrPath: null, // DRep signing doesn't need an address, just the skey
};

// Lookup by short name for convenience in scripts.
export const VOTERS_BY_NAME = {
  drep01: VOTERS[0],
  pool01: VOTERS[1],
  stake01: VOTERS[2],
  stake02: VOTERS[3],
  multisig: VOTERS[4],
};
