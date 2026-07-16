// Deterministic Ballot + Proposal factory shared by all scaffolds.
//
// Given a descriptor, builds the date window from the requested state
// (upcoming/live/closed) and upserts a Ballot keyed by title so repeat
// runs converge instead of duplicating.

import { Ballot } from '../../../schema/Ballot.js';
import { Proposal } from '../../../schema/Proposal.js';
import { ensureProposalContentHashes } from '../../../helper/proposalContent.js';
import {
  describe,
  loremText,
  authorList,
  pickInt,
  pickOne,
  snapshotTitle,
  SIZE_BUCKETS,
} from './loremGenerator.js';

const SAMPLE_CATEGORIES = [
  'Education',
  'Infrastructure',
  'Health',
  'Governance',
  'Treasury',
  'Research',
  'Community',
  'Tooling',
  'Outreach',
];
const SAMPLE_TAGS = [
  'longterm',
  'urgent',
  'audited',
  'experimental',
  'v2',
  'iteration',
  'compliance',
  'scaling',
  'developer',
  'voter-led',
];
const SAMPLE_REGIONS = ['LATAM', 'EU', 'APAC', 'AFRICA', 'NA'];

// Pool of possible facets. Each ballot picks a deterministic subset
// so the demo set exercises varied filter UIs rather than stamping
// the same columns everywhere (which makes them look structural).
const ALL_SCAFFOLD_FACETS = [
  {
    key: 'category',
    label: 'Category',
    type: 'enum',
    multi: true,
    options: SAMPLE_CATEGORIES,
    sortable: false,
    filterable: true,
  },
  {
    key: 'region',
    label: 'Region',
    type: 'enum',
    multi: true,
    options: SAMPLE_REGIONS,
    sortable: false,
    filterable: true,
  },
  {
    key: 'totalCost',
    label: 'Total cost',
    type: 'number',
    unit: 'ADA',
    sortable: true,
    filterable: true,
    defaultSort: 'desc',
  },
  {
    key: 'tags',
    label: 'Tags',
    type: 'enum',
    multi: true,
    options: SAMPLE_TAGS,
    sortable: false,
    filterable: true,
  },
];

// Pre-built combinations: each ballot gets one of these sets
// deterministically. Ensures variety — some ballots have category
// + cost (budget-style), others have region + tags, some have only
// one facet, some have all four.
const FACET_COMBOS = [
  ['category', 'totalCost'], // budget ballot: filter by category, sort by cost
  ['region', 'tags'], // geography + tags
  ['category', 'region', 'totalCost'], // treasury-style
  ['tags'], // minimal: just tags
  ['category', 'region', 'totalCost', 'tags'], // everything
  ['category'], // single enum
  ['totalCost', 'tags'], // cost-focused + tags
  ['region'], // geography only
];

function facetsForBallot(ballotTitle) {
  const idx = Math.floor(hashFloat(`${ballotTitle}|facetcombo`) * FACET_COMBOS.length);
  const keys = new Set(FACET_COMBOS[idx]);
  return ALL_SCAFFOLD_FACETS.filter((f) => keys.has(f.key));
}

function pickN(seed, pool, n) {
  const sorted = pool
    .map((v, i) => ({ v, sort: hashFloat(`${seed}|${i}|${v}`) }))
    .sort((a, b) => a.sort - b.sort);
  return sorted.slice(0, n).map((x) => x.v);
}

function hashFloat(s) {
  // Tiny inline hash → [0,1). Avoids importing crypto here just for
  // the picker; loremGenerator already does the heavy lifting.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return (h % 1_000_000) / 1_000_000;
}

// Each flavor declares (a) which on-chain validation script applies and
// (b) which voter groups the scaffold should validate in UserCache when
// seeding a ballot with that flavor. The seeder uses `eligibleGroups`
// to decide who can vote; Ballot.voterType is display-only.
//
// Groups correspond to VOTERS[*].voterGroup in ./fixtures.js:
//   "drep"  — DReps
//   "pool"  — SPOs
//   "stake" — Stakeholders
//
// `voterGroups` declares the eligibility + power-source pair that
// hydraPrepare.js translates into Hydra's `roleWeighting` object:
//   drep  → CredentialBased | StakeBased
//   pool  → CredentialBased | StakeBased | PledgeBased
//   stake → StakeBased
const VALIDATION_SCRIPTS = {
  // Single-group flavors
  dreps: {
    script: 'voterValidationDReps.js',
    voterType: 'DReps',
    startup: 'startupBallot.js',
    eligibleGroups: ['drep'],
    voterGroups: [{ group: 'drep', powerSource: 'StakeBased' }],
  },
  stake: {
    script: 'voterValidationStake.js',
    voterType: 'Stake',
    startup: 'startupBallot.js',
    eligibleGroups: ['stake'],
    voterGroups: [{ group: 'stake', powerSource: 'StakeBased' }],
  },
  poolPledge: {
    script: 'voterValidationPoolsPledge.js',
    voterType: 'SPOs (Pledge based)',
    startup: 'startupPledgeBasedVoting.js',
    eligibleGroups: ['pool'],
    voterGroups: [{ group: 'pool', powerSource: 'PledgeBased' }],
  },
  poolStake: {
    script: 'voterValidationPoolsStake.js',
    voterType: 'SPOs (Stake based)',
    startup: 'startupStakeBasedVoting.js',
    eligibleGroups: ['pool'],
    voterGroups: [{ group: 'pool', powerSource: 'StakeBased' }],
  },
  alwaysTrue: {
    script: 'voterValidationAlwaysTrue.js',
    voterType: 'All Voters',
    startup: 'startupBallot.js',
    eligibleGroups: ['drep', 'pool', 'stake'],
    voterGroups: [
      { group: 'drep', powerSource: 'StakeBased' },
      { group: 'pool', powerSource: 'StakeBased' },
      { group: 'stake', powerSource: 'StakeBased' },
    ],
  },
  // Combined-group flavors — scaffold-only. The real voter-validation
  // scripts don't natively take unions; these rely on alwaysTrue +
  // UserCache seeding to gate eligibility. Display strings make the
  // combination explicit.
  drepsPools: {
    script: 'voterValidationAlwaysTrue.js',
    voterType: 'DReps + SPOs',
    startup: 'startupBallot.js',
    eligibleGroups: ['drep', 'pool'],
    // RSS-v2-style heterogeneous power sources: DReps by delegated
    // voting power, SPOs by pledge.
    voterGroups: [
      { group: 'drep', powerSource: 'StakeBased' },
      { group: 'pool', powerSource: 'PledgeBased' },
    ],
  },
  drepsStake: {
    script: 'voterValidationAlwaysTrue.js',
    voterType: 'DReps + Stakeholders',
    startup: 'startupBallot.js',
    eligibleGroups: ['drep', 'stake'],
    voterGroups: [
      { group: 'drep', powerSource: 'StakeBased' },
      { group: 'stake', powerSource: 'StakeBased' },
    ],
  },
  poolsStake: {
    script: 'voterValidationAlwaysTrue.js',
    voterType: 'SPOs + Stakeholders',
    startup: 'startupBallot.js',
    eligibleGroups: ['pool', 'stake'],
    voterGroups: [
      { group: 'pool', powerSource: 'StakeBased' },
      { group: 'stake', powerSource: 'StakeBased' },
    ],
  },
  allGroups: {
    script: 'voterValidationAlwaysTrue.js',
    voterType: 'DReps + SPOs + Stakeholders',
    startup: 'startupBallot.js',
    eligibleGroups: ['drep', 'pool', 'stake'],
    voterGroups: [
      { group: 'drep', powerSource: 'StakeBased' },
      { group: 'pool', powerSource: 'StakeBased' },
      { group: 'stake', powerSource: 'StakeBased' },
    ],
  },
};

export { VALIDATION_SCRIPTS };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Minimum buffer between "now" and the voting window open. Hydra's minting
// policy is timelocked `before(votingOpenSlot)` — once that slot is reached
// the policy is permanently locked and `/prepare` cannot mint the ballot
// tokens. 4 minutes leaves enough time for the prepare tx to confirm on-chain
// before the window opens.
const HYDRA_PREPARE_BUFFER_MS = 4 * MINUTE;

/**
 * Compute vote period bounds for a given state.
 *
 * @param {"upcoming"|"live"|"closed"} state
 * @param {"legacy"|"hydra"} [source="legacy"] — Hydra ballots must have a
 *   future votePeriodStart (timelock requirement) so `live` gets a short
 *   buffer instead of a past start, and `closed` is rejected.
 */
function windowForState(state, source = 'legacy', simulated = false, now = Date.now()) {
  // Legacy is a read-only archive surface in this codebase — upcoming
  // and live legacy ballots don't represent anything real and would
  // only muddy the unified listing. Block them at the factory so no
  // scaffold can create one by mistake.
  if (source === 'legacy' && state !== 'closed') {
    throw new Error(
      `Cannot scaffold a '${state}' legacy ballot. Legacy is archive-only — use source:"hydra" for upcoming/live ballots.`,
    );
  }
  switch (state) {
    case 'upcoming':
      return { votePeriodStart: new Date(now + 1 * DAY), votePeriodEnd: new Date(now + 8 * DAY) };
    case 'live':
      // Legacy can back-date to pretend the ballot is already running;
      // real Hydra must keep the window ahead of the mint tx
      // confirmation. Simulated Hydra ballots never hit the chain, so
      // they can back-date like legacy.
      return source === 'hydra' && !simulated
        ? {
            votePeriodStart: new Date(now + HYDRA_PREPARE_BUFFER_MS),
            votePeriodEnd: new Date(now + 7 * DAY),
          }
        : { votePeriodStart: new Date(now - 1 * DAY), votePeriodEnd: new Date(now + 6 * DAY) };
    case 'closed':
      if (source === 'hydra' && !simulated) {
        throw new Error(
          "Cannot scaffold a 'closed' Hydra ballot without simulated:true — the mint-policy timelock requires votePeriodStart to be in the future at /prepare time. Run the full lifecycle (prepare → start → close/finalize) to produce a real closed Hydra ballot, or pass simulated:true for a fake archive row.",
        );
      }
      return { votePeriodStart: new Date(now - 14 * DAY), votePeriodEnd: new Date(now - 7 * DAY) };
    default:
      throw new Error(`Unknown ballot state: ${state}`);
  }
}

/**
 * Produce deterministic, plausible on-chain-looking identifiers for a
 * simulated Hydra ballot. Keyed off the ballot title so repeat runs
 * converge. These never hit the chain — they exist purely so closed
 * Hydra archive rows render in the UI with the same shape as real ones.
 */
import crypto from 'node:crypto';
function simulatedHydraIds(title) {
  const h = crypto.createHash('sha256').update(title).digest('hex');
  // Policy IDs are 28 bytes (56 hex chars).
  const policyId = h.slice(0, 56);
  // Asset names share the 28-byte ballot fingerprint prefix.
  const fingerprint = h.slice(0, 56);
  // CIP-30 head IDs are typically 32 bytes hex.
  const headId = h.slice(0, 64);
  // IPFS CIDv1 lookalike. Not a valid base32-encoded CID but enough for
  // display. Real CIDs start with `bafy...`.
  const cid = `bafy${h.slice(0, 46)}`;
  // Cardano tx hashes are 32 bytes hex.
  const txHash = h.slice(8, 72).padEnd(64, '0').slice(0, 64);
  return {
    hydraEndpoint: `https://simulated.hydra.scaffold/${h.slice(0, 8)}`,
    hydraHeadId: headId,
    hydraHeadStatus: 'Final',
    ballotCid: cid,
    instancePolicyId: policyId,
    definitionAssetName: `${fingerprint.slice(0, 28)}363030`, // +600 suffix
    instanceAssetName: `${fingerprint.slice(0, 28)}363031`, // +601 suffix
    prepareTxHash: txHash,
    ballotFingerprint: fingerprint,
  };
}

/**
 * Build the externalProposal.snapshot field with realistic governance-
 * proposal content. Mirrors what an upstream proposals module would
 * push via /api/v1/admin/ballots/import, so the scaffold exercises the
 * same downstream rendering paths.
 *
 * Sized varies per proposal so the demo set covers tiny → limit-length
 * descriptions across ballots.
 */
function buildSnapshot(seed, options) {
  const summary = describe(`${seed}|summary`);
  const rationale = describe(`${seed}|rationale`, 'long');
  const authors = authorList(`${seed}|authors`, pickInt(`${seed}|n`, 1, 4));
  const version = pickOne(`${seed}|ver`, ['v1', 'v1.1', 'v2', 'v2.3', 'draft']);

  // Only emit facet values for keys declared on this ballot's facets.
  // Caller passes the set of active keys so snapshot.facets doesn't
  // carry orphans that the ballot's filter UI wouldn't know about.
  const activeKeys = options?.facetKeys || new Set(['category', 'region', 'totalCost', 'tags']);
  const facets = {};
  if (activeKeys.has('category')) {
    const categories = pickN(`${seed}|cat`, SAMPLE_CATEGORIES, pickInt(`${seed}|cn`, 1, 3));
    facets.category = categories.join(',');
  }
  if (activeKeys.has('region')) {
    const region = pickN(`${seed}|region`, SAMPLE_REGIONS, pickInt(`${seed}|rn`, 1, 3)).join(',');
    facets.region = region;
  }
  if (activeKeys.has('totalCost')) {
    facets.totalCost = pickInt(`${seed}|cost`, 5_000, 2_500_000) * 1_000_000;
  }
  if (activeKeys.has('tags') && hashFloat(`${seed}|tagsroll`) < 0.6) {
    const tags = pickN(`${seed}|tags`, SAMPLE_TAGS, pickInt(`${seed}|tn`, 1, 4));
    facets.tags = tags.join(',');
  }

  return {
    title: snapshotTitle(seed),
    summary: summary.text,
    rationale: rationale.text,
    authors,
    version,
    facets,
    ...(options?.extra || {}),
  };
}

// Build the first-class proposal-level fields (summary, rationale,
// authors, version) for a scaffold seed. Same content the snapshot
// carries — but populated as canonical Proposal fields rather than
// buried under externalProposal.snapshot.
function buildProposalAuthorship(seed) {
  return {
    summary: describe(`${seed}|summary`).text,
    rationale: describe(`${seed}|rationale`, 'long').text,
    authors: authorList(`${seed}|authors`, pickInt(`${seed}|n`, 1, 4)).map((name) => ({ name })),
    version: pickOne(`${seed}|ver`, ['v1', 'v1.1', 'v2', 'v2.3', 'draft']),
  };
}

// Candidate roster used by the single-pick-from-many and multi-pick
// proposal templates below. Exercises the full typed VoteOption shape:
//   required: id, label
//   optional: description, referenceUrl, imageUrl
//   free-form: metadata.* (platform here — it's candidate-election-
//   specific, not a universal option field)
// imageUrl uses https://picsum.photos/id/<id>/400/400 — picsum resolves
// the same photo for the same id every time, so rescaffold runs keep
// the contentHash byte-stable. 400x400 square is a reasonable portrait
// fetch; frontends can resize by replacing the dimensions.
const CC_CANDIDATES = [
  {
    id: 1,
    label: 'Dr. Amara Okeke',
    description: 'Constitutional law scholar, 12 years on chain governance committees.',
    referenceUrl: 'https://example.test/cc/amara-okeke',
    imageUrl: 'https://picsum.photos/id/64/400/400',
    metadata: {
      platform: 'Strong process safeguards, conservative interpretation of the constitution.',
    },
  },
  {
    id: 2,
    label: 'Marco Chen',
    description:
      'Open-source engineer; led three protocol upgrades and the original tooling working group.',
    referenceUrl: 'https://example.test/cc/marco-chen',
    imageUrl: 'https://picsum.photos/id/342/400/400',
    metadata: {
      platform:
        'Engineering rigor, fast feedback loops, defer to ecosystem builders on technical questions.',
    },
  },
  {
    id: 3,
    label: 'Priya Singh',
    description:
      'Treasury auditor and former regulator. Public records of independent action against three governance proposals.',
    referenceUrl: 'https://example.test/cc/priya-singh',
    imageUrl: 'https://picsum.photos/id/91/400/400',
    metadata: {
      platform: 'Treasury accountability, audit-first decisions, mandatory disclosures.',
    },
  },
  {
    id: 4,
    label: 'Jonas Bergström',
    description: 'Long-time validator operator (4y stake top-50). Active in pool governance.',
    referenceUrl: 'https://example.test/cc/jonas-bergstrom',
    imageUrl: 'https://picsum.photos/id/177/400/400',
    metadata: {
      platform: 'Operator experience, decentralization-first, push back on protocol creep.',
    },
  },
  {
    id: 5,
    label: 'Dr. Lina Rossi',
    description: 'Researcher specializing in mechanism design and on-chain incentive systems.',
    referenceUrl: 'https://example.test/cc/lina-rossi',
    imageUrl: 'https://picsum.photos/id/823/400/400',
    metadata: {
      platform: 'Evidence-based mechanism reform, formal models for treasury allocation.',
    },
  },
  {
    id: 6,
    label: 'Tomas Alvarez',
    description: 'Community organizer; founded LATAM stakeholder collective with 8k members.',
    referenceUrl: 'https://example.test/cc/tomas-alvarez',
    imageUrl: 'https://picsum.photos/id/577/400/400',
    metadata: {
      platform: 'Inclusive process, multilingual outreach, lower the barrier for small voters.',
    },
  },
  {
    id: 7,
    label: 'Sarah Kim',
    description: 'Cryptography researcher; co-author of the staking-pool proof framework.',
    referenceUrl: 'https://example.test/cc/sarah-kim',
    imageUrl: 'https://picsum.photos/id/1005/400/400',
    metadata: {
      platform:
        'Verifiable governance — every constitutional decision must produce a public audit artifact.',
    },
  },
];

const FUNDING_TRACKS = [
  {
    id: 1,
    label: 'Education & onboarding',
    description: 'Curriculum, workshops, and translated documentation for new participants.',
    referenceUrl: 'https://example.test/tracks/education',
  },
  {
    id: 2,
    label: 'Infrastructure resilience',
    description: 'Mirror nodes, monitoring, and cross-region redundancy for core services.',
    referenceUrl: 'https://example.test/tracks/infrastructure',
  },
  {
    id: 3,
    label: 'Tooling & developer experience',
    description: 'Libraries, CLIs, IDE integrations, and reference implementations.',
    referenceUrl: 'https://example.test/tracks/tooling',
  },
  {
    id: 4,
    label: 'Treasury audit & oversight',
    description: 'Independent audits, on-chain disclosure tooling, post-funding reporting.',
    referenceUrl: 'https://example.test/tracks/audit',
  },
  {
    id: 5,
    label: 'Research & mechanism design',
    description: 'Peer-reviewed publications on consensus, incentives, and governance design.',
    referenceUrl: 'https://example.test/tracks/research',
  },
  {
    id: 6,
    label: 'Community outreach',
    description: 'Regional ambassador programs, conferences, and on-the-ground events.',
    referenceUrl: 'https://example.test/tracks/outreach',
  },
];

function defaultProposals(ballotId, ballotTitle) {
  // buildProposalAuthorship handles summary + rationale — there's no
  // separate `description` field anymore.
  const externalIdFor = (type) => `scaffold-${ballotTitle.replace(/[^a-zA-Z0-9]/g, '-')}-${type}`;
  // Pass the ballot's active facet keys so snapshot.facets only
  // carries values for declared facets (no orphan keys).
  const activeFacetKeys = new Set(facetsForBallot(ballotTitle).map((f) => f.key));
  const snapshotOpts = { facetKeys: activeFacetKeys };

  return [
    {
      ballotId,
      title: 'Default Proposal: Yes/No/Abstain',
      ...buildProposalAuthorship(`${ballotTitle}|default`),
      voteType: 'choice',
      voterBudget: 1,
      voteOptions: [
        { id: 1, label: 'Yes' },
        { id: 2, label: 'No' },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|default|sub`, 1)[0],
        fundingRequested: false,
      },
      externalProposal: {
        id: externalIdFor('default'),
        url: `https://proposals.example.test/p/${externalIdFor('default')}`,
        snapshot: buildSnapshot(`${ballotTitle}|default`, snapshotOpts),
      },
    },
    {
      ballotId,
      title: 'Scale Proposal',
      ...buildProposalAuthorship(`${ballotTitle}|scale`),
      voteType: 'scale',
      voteIncrement: 1,
      voteOptions: [
        { id: -100, label: 'Strongly oppose' },
        { id: 0, label: 'Neutral' },
        { id: 100, label: 'Strongly support' },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|scale|sub`, 1)[0],
        scaleAnchors: { min: -100, mid: 0, max: 100 },
      },
      externalProposal: {
        id: externalIdFor('scale'),
        url: `https://proposals.example.test/p/${externalIdFor('scale')}`,
        snapshot: buildSnapshot(`${ballotTitle}|scale`, snapshotOpts),
      },
    },
    {
      ballotId,
      title: 'Ranked Choice Proposal',
      ...buildProposalAuthorship(`${ballotTitle}|ranked`),
      // Mandatory answer — voter may not abstain on the ranked-choice
      // proposal. Exercises the requireAnswer:true opt-out path.
      requireAnswer: true,
      voteType: 'ranked',
      voteOptions: [
        { id: 1, label: 'Alice Reyes' },
        { id: 2, label: 'Bob Tanaka' },
        { id: 3, label: 'Carol Okafor' },
        { id: 4, label: 'Dave Lindgren' },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|ranked|sub`, 1)[0],
        candidatePool: ['Alice Reyes', 'Bob Tanaka', 'Carol Okafor', 'Dave Lindgren'],
      },
      externalProposal: {
        id: externalIdFor('ranked'),
        url: `https://proposals.example.test/p/${externalIdFor('ranked')}`,
        snapshot: buildSnapshot(`${ballotTitle}|ranked`, snapshotOpts),
      },
    },
    // Single-pick from many — Constitutional-Committee-style election.
    // voteType "choice" works here: one selection from the option list.
    // Each option carries name + description + referenceUrl + imageUrl
    // + platform so the frontend can render a candidate card (not just
    // a label).
    {
      ballotId,
      title: 'Single Choice: Elect a CC Member',
      ...buildProposalAuthorship(`${ballotTitle}|ccelect`),
      voteType: 'choice',
      voterBudget: 1,
      voteOptions: CC_CANDIDATES,
      data: {
        submittedBy: authorList(`${ballotTitle}|ccelect|sub`, 1)[0],
        seatsAvailable: 1,
        electionRound: pickInt(`${ballotTitle}|ccelect|round`, 1, 4),
      },
      externalProposal: {
        id: externalIdFor('cc-elect'),
        url: `https://proposals.example.test/p/${externalIdFor('cc-elect')}`,
        snapshot: buildSnapshot(`${ballotTitle}|ccelect`, snapshotOpts),
      },
    },
    // Multi-pick (up to 3) from a list of funding tracks. Modeled as
    // voteType "multi-choice" with minSelections: 1, maxSelections: 3.
    // Per-option metadata exercises the same render path as the CC ballot.
    {
      ballotId,
      title: 'Multi Select: Fund up to 3 Tracks',
      ...buildProposalAuthorship(`${ballotTitle}|fundtracks`),
      voteType: 'multi-choice',
      minSelections: 1,
      maxSelections: 3,
      voteOptions: FUNDING_TRACKS,
      data: {
        submittedBy: authorList(`${ballotTitle}|fundtracks|sub`, 1)[0],
        totalFundingPool:
          pickInt(`${ballotTitle}|fundtracks|pool`, 1_000_000, 25_000_000) * 1_000_000,
      },
      externalProposal: {
        id: externalIdFor('fund-tracks'),
        url: `https://proposals.example.test/p/${externalIdFor('fund-tracks')}`,
        snapshot: buildSnapshot(`${ballotTitle}|fundtracks`, snapshotOpts),
      },
    },
    // Knapsack budget: pick a subset of projects whose summed cost
    // fits the voter's budget. Maps to Hydra multi-choice; backend
    // enforces the cost cap at /draft.
    {
      ballotId,
      title: 'Budget: Fund projects within 6 months of capacity',
      ...buildProposalAuthorship(`${ballotTitle}|budget`),
      voteType: 'budget',
      voterBudget: 6,
      voteOptions: [
        { id: 1, label: 'Voter-education campaign', cost: 1 },
        { id: 2, label: 'Translation + localization push', cost: 2 },
        { id: 3, label: 'Independent treasury audit', cost: 3 },
        { id: 4, label: 'Validator resilience mirrors', cost: 2 },
        { id: 5, label: 'Mechanism-design research paper', cost: 4 },
        { id: 6, label: 'Community ambassador program', cost: 1 },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|budget|sub`, 1)[0],
        capacityUnits: 'engineer-months',
        capacityCap: 6,
      },
      externalProposal: {
        id: externalIdFor('budget'),
        url: `https://proposals.example.test/p/${externalIdFor('budget')}`,
        snapshot: buildSnapshot(`${ballotTitle}|budget`, snapshotOpts),
      },
    },
    // Weighted allocation: distribute 100 points across funding
    // categories. Maps to Hydra method:"weighted"; backend and Hydra
    // both enforce Σ value = voterBudget.
    {
      ballotId,
      title: 'Weighted: Allocate 100% across treasury categories',
      ...buildProposalAuthorship(`${ballotTitle}|weighted`),
      voteType: 'weighted',
      voterBudget: 100,
      voteOptions: [
        { id: 1, label: 'Protocol development' },
        { id: 2, label: 'Ecosystem grants' },
        { id: 3, label: 'Operations & infrastructure' },
        { id: 4, label: 'Education & onboarding' },
        { id: 5, label: 'Governance tooling' },
        { id: 6, label: 'Reserve / contingency' },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|weighted|sub`, 1)[0],
        allocationUnit: 'percent',
        allocationCap: 100,
      },
      externalProposal: {
        id: externalIdFor('weighted'),
        url: `https://proposals.example.test/p/${externalIdFor('weighted')}`,
        snapshot: buildSnapshot(`${ballotTitle}|weighted`, snapshotOpts),
      },
    },
    // Likert: rate each option independently on a 1-5 scale.
    // Produces per-option distribution + Majority Judgment ranking.
    {
      ballotId,
      title: 'Likert: Rate Budget Thresholds',
      ...buildProposalAuthorship(`${ballotTitle}|likert`),
      voteType: 'likert',
      ratingRange: { min: 1, max: 5 },
      voteOptions: [
        { id: 1, label: 'Greater than 2500' },
        { id: 2, label: '2500' },
        { id: 3, label: '2000' },
        { id: 4, label: '1000' },
        { id: 5, label: '750' },
        { id: 6, label: '500' },
        { id: 7, label: 'Less than 500' },
      ],
      data: {
        submittedBy: authorList(`${ballotTitle}|likert|sub`, 1)[0],
        ratingLabels: { 1: 'Least Preferred', 5: 'Most Preferred' },
      },
      externalProposal: {
        id: externalIdFor('likert'),
        url: `https://proposals.example.test/p/${externalIdFor('likert')}`,
        snapshot: buildSnapshot(`${ballotTitle}|likert`, snapshotOpts),
      },
    },
  ];
}

/**
 * Upsert a scaffolded ballot. Returns the Ballot document.
 *
 * @param {Object} opts
 * @param {"legacy"|"hydra"} opts.source
 * @param {"upcoming"|"live"|"closed"} opts.state
 * @param {keyof typeof VALIDATION_SCRIPTS} [opts.flavor="dreps"]
 * @param {number} [opts.index=1]   disambiguator baked into the title for determinism
 * @param {string} [opts.titlePrefix]
 */
export async function upsertScaffoldBallot({
  source,
  state,
  flavor = 'dreps',
  index = 1,
  titlePrefix = 'Scaffold',
  provisionalResultsEnabled = false,
  simulated = false,
}) {
  const flavorCfg = VALIDATION_SCRIPTS[flavor];
  if (!flavorCfg) throw new Error(`Unknown validation flavor: ${flavor}`);

  const title = `${titlePrefix}/${source}/${flavor}/${state}#${String(index).padStart(3, '0')}`;
  const window = windowForState(state, source, simulated);

  const ballotDesc = describe(`${title}|ballot`);
  const voterDescBucket = SIZE_BUCKETS.modest;
  const setFields = {
    title,
    description: ballotDesc.text,
    voterType: flavorCfg.voterType,
    voterGroups: flavorCfg.voterGroups || [],
    voterDescription: loremText(`${title}|voterDesc`, voterDescBucket.chars, 1),
    facets: facetsForBallot(title),
    proposalSource: {
      moduleId: 'scaffold-mixed-demo',
      moduleUrl: 'https://proposals.example.test/',
      externalBallotId: title,
      version: 'scaffold-v1',
      importedAt: new Date(),
      importMethod: 'upload',
      importedBy: 'scaffold',
    },
    voteWeighted: true,
    voteFilters: true,
    voteAuthorityId: `scaffold-authority`,
    voteAuthorityAddress: `scaffold-address`,
    voterValidationScript: flavorCfg.script,
    rollupScript: 'rollupBallot.js',
    startupScript: flavorCfg.startup,
    status: state,
    source,
    provisionalResultsEnabled,
  };

  // Window handling — the voting window becomes mint-policy-anchored once
  // /prepare succeeds (hydraEndpoint set). Until then it's safe to refresh
  // on each run so `live` ballots don't end up with a stale past start if
  // the first attempt failed.
  const existing = await Ballot.findOne({ title }).lean();
  const anchored = Boolean(existing?.hydraEndpoint);
  if (!anchored) {
    setFields.votePeriodStart = window.votePeriodStart;
    setFields.votePeriodEnd = window.votePeriodEnd;
  }

  const setOnInsertFields = {
    proposalPeriodStart: new Date(Date.now() - 30 * DAY),
    proposalPeriodEnd: new Date(Date.now() - 15 * DAY),
  };

  // Simulated Hydra closed ballots — stamp deterministic, on-chain-
  // looking IDs so the UX renders like a real archived Hydra ballot.
  // These are scaffold-only; nothing ever hit a chain.
  if (simulated && source === 'hydra') {
    Object.assign(setFields, simulatedHydraIds(title));
  }

  const ballot = await Ballot.findOneAndUpdate(
    { title },
    { $set: setFields, $setOnInsert: setOnInsertFields },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Proposals: upsert-by-title-within-ballot for idempotence.
  for (const p of defaultProposals(ballot._id, title)) {
    await Proposal.updateOne(
      { ballotId: ballot._id, title: p.title },
      { $set: p },
      { upsert: true },
    );
  }

  // Stamp contentHash on every proposal after they land. Runs on every
  // scaffold invocation so the hash tracks any edit to proposal content.
  await ensureProposalContentHashes(ballot._id);

  return ballot;
}
