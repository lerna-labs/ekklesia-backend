// Synthetic voter cohort for scaffold-only demos. None of these IDs
// resolve to real on-chain credentials — they exist purely to give the
// frontend enough variety to render realistic vote distributions.
//
// Real preprod voters live in fixtures.js (those are needed for E2E
// signing). When you need a "vote came from a real keyholder", use
// fixtures; when you just need numbers in the result tally, use these.
//
// IDs are deterministic per-group and per-index so re-runs converge:
//   drep_synth_NNN  → drep group
//   pool_synth_NNN  → pool group
//   stake_synth_NNN → default group (stakeholders)

const ID_PREFIX = {
  drep: "drep_synth_",
  pool: "pool_synth_",
  default: "stake_synth_",
};

const NAME_POOL = {
  drep: [
    "DRep Aurora", "DRep Borealis", "DRep Caldera", "DRep Delta", "DRep Echo",
    "DRep Fulgor", "DRep Gamma", "DRep Helios", "DRep Iris", "DRep Juno",
    "DRep Kairos", "DRep Lyra",
  ],
  pool: [
    "Skylight Pool", "Granite Pool", "Tundra Pool", "Mariner Pool", "Stellar Pool",
    "Quartz Pool", "Cobalt Pool", "Radon Pool",
  ],
  default: [
    "ADA Holder Α", "ADA Holder Β", "ADA Holder Γ", "ADA Holder Δ", "ADA Holder Ε",
    "ADA Holder Ζ", "ADA Holder Η", "ADA Holder Θ", "ADA Holder Ι", "ADA Holder Κ",
    "ADA Holder Λ", "ADA Holder Μ",
  ],
};

function makeCohort(group, count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const idx = String(i).padStart(3, "0");
    out.push({
      userId: `${ID_PREFIX[group]}${idx}`,
      name: NAME_POOL[group][(i - 1) % NAME_POOL[group].length] + ` #${idx}`,
      voterGroup: group,
      validated: true,
      kind: "synthetic",
    });
  }
  return out;
}

// Cohort sizes were tuned to produce believable totals when each ballot
// allocates 18-27B ADA across its validated voters using the power-law
// distribution in votingPowerDistribution.js. Adjust if/when the math
// drifts.
export const SYNTHETIC_VOTERS = [
  ...makeCohort("drep", 12),
  ...makeCohort("pool", 8),
  ...makeCohort("default", 12),
];
