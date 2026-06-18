import { deriveProposalTally } from "../helper/results/hydraTally.js";

// ---------------------------------------------------------------------------
// Minimal fixtures. Ballot is just `{voteWeighted: boolean}`; proposal
// provides the voteType + voteOptions the downstream helpers read.
// ---------------------------------------------------------------------------

function makeAudit(voters) {
  return { voters };
}
function answer(questionId, selection) {
  return { questionId, selection };
}
function answerAbstain(questionId) {
  return { questionId, abstain: true };
}
function voter(id, hrp, answers) {
  return {
    voterId: id,
    credentialHrp: hrp,
    evidence: { specVersion: "ekklesia/1.0", responderRole: hrp, answers },
  };
}
function voterMeta(userId, voterGroup, votingPower = 1) {
  return [userId, { userId, voterGroup, votingPower }];
}

// ---------------------------------------------------------------------------
// §Acceptance #2 — range {-2, 0, 0, 3, 5} over a -5..5 grid → mean 1.2,
// median 0. Single voter group so resultsByGroup.drep carries the stats.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — range (scale) §Acceptance #2", () => {
  const proposal = {
    _id: "q-scale",
    voteType: "scale",
    voteOptions: [
      { id: -5, label: "-5" },
      { id: 5, label: "5" },
    ],
    voteIncrement: 1,
    requireAnswer: false,
  };
  const ballot = { voteWeighted: false };

  test("mean 1.2, median 0 for {-2, 0, 0, 3, 5}", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [answer("q-scale", [-2])]),
      voter("drep1b", "drep", [answer("q-scale", [0])]),
      voter("drep1c", "drep", [answer("q-scale", [0])]),
      voter("drep1d", "drep", [answer("q-scale", [3])]),
      voter("drep1e", "drep", [answer("q-scale", [5])]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep"),
      voterMeta("drep1b", "drep"),
      voterMeta("drep1c", "drep"),
      voterMeta("drep1d", "drep"),
      voterMeta("drep1e", "drep"),
    ]);

    const { resultsByGroup, proposalParticipation } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });

    const drep = resultsByGroup.drep;
    expect(drep).toBeDefined();
    expect(drep.scale).toBeDefined();
    expect(drep.scale.stats.count).toBe(5);
    expect(drep.scale.stats.mean).toBeCloseTo(1.2, 10);
    expect(drep.scale.stats.median).toBe(0);
    expect(drep.scale.stats.min).toBe(-2);
    expect(drep.scale.stats.max).toBe(5);
    expect(drep.totalVotes).toBe(5);
    expect(proposalParticipation.voterCount.drep).toBe(5);
  });

  test("abstain rows surface but do not flow into stats.distribution", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [answer("q-scale", [1])]),
      voter("drep1b", "drep", [answerAbstain("q-scale")]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep"),
      voterMeta("drep1b", "drep"),
    ]);
    const { results, resultsByGroup, proposalParticipation } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    // Top-level results carries an Abstain row with count=1
    const abstainTop = results.find((r) => r.id === "abstain");
    expect(abstainTop).toBeDefined();
    expect(abstainTop.count).toBe(1);
    // Per-group stats exclude abstainers
    expect(resultsByGroup.drep.scale.stats.count).toBe(1);
    expect(resultsByGroup.drep.scale.stats.mean).toBe(1);
    // Participation counts only non-abstain voters
    expect(proposalParticipation.voterCount.drep).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Likert — distribution + majority-judgment sanity check.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — likert", () => {
  const proposal = {
    _id: "q-likert",
    voteType: "likert",
    voteOptions: [
      { id: 1, label: "Option A" },
      { id: 2, label: "Option B" },
    ],
    ratingRange: { min: 1, max: 5, step: 1 },
    requireAnswer: true,
  };
  const ballot = { voteWeighted: false };

  test("per-option distribution + stats land on resultsByGroup.likert", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [
        answer("q-likert", [
          { option: 1, value: 4 },
          { option: 2, value: 2 },
        ]),
      ]),
      voter("drep1b", "drep", [
        answer("q-likert", [
          { option: 1, value: 5 },
          { option: 2, value: 3 },
        ]),
      ]),
      voter("drep1c", "drep", [
        answer("q-likert", [
          { option: 1, value: 3 },
          { option: 2, value: 1 },
        ]),
      ]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep"),
      voterMeta("drep1b", "drep"),
      voterMeta("drep1c", "drep"),
    ]);
    const { resultsByGroup } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    const drep = resultsByGroup.drep;
    expect(drep.likert).toBeDefined();
    expect(drep.likert.ratingRange).toEqual({ min: 1, max: 5, step: 1 });
    expect(drep.likert.options).toHaveLength(2);
    const opt1 = drep.likert.options.find((o) => o.id === 1);
    expect(opt1.stats.count).toBe(3);
    // ratings {4,5,3} → mean 4
    expect(opt1.stats.mean).toBe(4);
    expect(opt1.stats.median).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Weighted — totalPoints per option, mean-per-option sanity check.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — weighted", () => {
  const proposal = {
    _id: "q-weighted",
    voteType: "weighted",
    voteOptions: [
      { id: 1, label: "Option A" },
      { id: 2, label: "Option B" },
    ],
    voterBudget: 10,
    requireAnswer: false,
  };
  const ballot = { voteWeighted: false };

  test("totalPoints aggregates across ballots", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [
        answer("q-weighted", [
          { option: 1, value: 7 },
          { option: 2, value: 3 },
        ]),
      ]),
      voter("drep1b", "drep", [
        answer("q-weighted", [
          { option: 1, value: 5 },
          { option: 2, value: 5 },
        ]),
      ]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep"),
      voterMeta("drep1b", "drep"),
    ]);
    const { resultsByGroup } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    const drep = resultsByGroup.drep;
    expect(drep.weighted).toBeDefined();
    expect(drep.weighted.budget).toBe(10);
    expect(drep.weighted.answeringBallots).toBe(2);
    const opt1 = drep.weighted.results.find((r) => r.option === 1);
    expect(opt1.totalPoints).toBe(12);
    // mean per option = totalPoints / answeringBallots
    expect(opt1.mean).toBeCloseTo(6, 10);
  });
});

// ---------------------------------------------------------------------------
// Ranked — per-rank counts + rankDepth preserved.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — ranked", () => {
  const proposal = {
    _id: "q-ranked",
    voteType: "ranked",
    voteOptions: [
      { id: 1, label: "Option A" },
      { id: 2, label: "Option B" },
      { id: 3, label: "Option C" },
    ],
    requireAnswer: true,
  };
  const ballot = { voteWeighted: false };

  test("rows carry per-rank counts", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [answer("q-ranked", [1, 2, 3])]),
      voter("drep1b", "drep", [answer("q-ranked", [2, 1, 3])]),
      voter("drep1c", "drep", [answer("q-ranked", [1, 3, 2])]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep"),
      voterMeta("drep1b", "drep"),
      voterMeta("drep1c", "drep"),
    ]);
    const { resultsByGroup } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    expect(resultsByGroup.drep.ranked).toBeDefined();
    expect(resultsByGroup.drep.ranked.rankDepth).toBe(3);
    const opt1Row = resultsByGroup.drep.ranked.rows.find((r) => r.id === 1);
    expect(opt1Row.counts[0]).toBe(2); // first-pref count for option 1
    expect(opt1Row.counts[1]).toBe(1); // second-pref count for option 1
  });
});

// ---------------------------------------------------------------------------
// participatingAbstainers — the pool ∩ proposal-abstainers intersection used
// by resultsCalculationMode: "participation". An all-abstain voter is NOT in
// the pool, so must not be subtracted; a no-answer voter is "did not vote",
// not an abstainer.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — participatingAbstainers intersection", () => {
  const proposal = {
    _id: "q-choice",
    voteType: "choice",
    voteOptions: [
      { id: 1, label: "Yes" },
      { id: 2, label: "No" },
    ],
    requireAnswer: false,
  };
  const ballot = { voteWeighted: true };

  test("counts only pool members who abstained on this proposal", () => {
    const auditFull = makeAudit([
      // A: voted Yes here → in pool, not an abstainer here
      voter("A", "drep", [answer("q-choice", [1])]),
      // B: abstained here but voted on another proposal → in pool, abstainer here
      voter("B", "drep", [answerAbstain("q-choice"), answer("q-other", [1])]),
      // C: abstained on everything → NOT in pool, must be excluded
      voter("C", "drep", [answerAbstain("q-choice"), answerAbstain("q-other")]),
      // D: no answer for this proposal → "did not vote", not an abstainer
      voter("D", "drep", [answer("q-other", [2])]),
    ]);
    const votersByUserId = new Map([
      voterMeta("A", "drep", 100),
      voterMeta("B", "drep", 200),
      voterMeta("C", "drep", 100),
      voterMeta("D", "drep", 100),
    ]);

    const { ballotParticipation, proposalParticipation, participatingAbstainers } =
      deriveProposalTally({ ballot, proposal, auditFull, votersByUserId });

    // Pool = A, B, D (each cast ≥1 non-abstain somewhere); C excluded.
    expect(ballotParticipation.voterCount.drep).toBe(3);
    expect(ballotParticipation.totalVotingPower.drep).toBe(400);
    // Non-abstain voters on this proposal = A only.
    expect(proposalParticipation.voterCount.drep).toBe(1);
    // Pool ∩ abstainers-on-q-choice = B only (C not in pool, D no answer).
    expect(participatingAbstainers.voterCount.drep).toBe(1);
    expect(participatingAbstainers.totalVotingPower.drep).toBe(200);

    // Denominator the frontend renders in participation mode.
    const denom =
      ballotParticipation.voterCount.drep - participatingAbstainers.voterCount.drep;
    expect(denom).toBe(2); // A (yes) + D (did-not-vote-here)
  });

  test("empty when the only abstainers never voted anywhere", () => {
    const auditFull = makeAudit([
      voter("A", "drep", [answer("q-choice", [1])]),
      voter("C", "drep", [answerAbstain("q-choice")]),
    ]);
    const votersByUserId = new Map([
      voterMeta("A", "drep", 100),
      voterMeta("C", "drep", 100),
    ]);
    const { participatingAbstainers } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    expect(participatingAbstainers.voterCount.drep).toBeUndefined();
    expect(participatingAbstainers).toEqual({ totalVotingPower: {}, voterCount: {} });
  });
});

// ---------------------------------------------------------------------------
// Multi-group reconciliation — totalVotes must be distinct-voter, not unwound.
// ---------------------------------------------------------------------------

describe("deriveProposalTally — group separation + reconciliation", () => {
  const proposal = {
    _id: "q-choice",
    voteType: "choice",
    voteOptions: [
      { id: 1, label: "Yes" },
      { id: 2, label: "No" },
    ],
    requireAnswer: false,
  };
  const ballot = { voteWeighted: false };

  test("drep and pool groups tracked independently", () => {
    const auditFull = makeAudit([
      voter("drep1a", "drep", [answer("q-choice", [1])]),
      voter("drep1b", "drep", [answer("q-choice", [2])]),
      voter("pool1a", "pool", [answer("q-choice", [1])]),
      voter("pool1b", "pool", [answer("q-choice", [1])]),
    ]);
    const votersByUserId = new Map([
      voterMeta("drep1a", "drep", 100),
      voterMeta("drep1b", "drep", 200),
      voterMeta("pool1a", "pool", 1),
      voterMeta("pool1b", "pool", 1),
    ]);
    const { results, resultsByGroup, proposalParticipation } = deriveProposalTally({
      ballot,
      proposal,
      auditFull,
      votersByUserId,
    });
    // Top-level Yes count = 3 across both groups
    const yes = results.find((r) => r.id === 1);
    expect(yes.count).toBe(3);
    expect(yes.votingPower).toBe(100 + 1 + 1); // drep1a + pool1a + pool1b
    // Per-group buckets are isolated
    expect(resultsByGroup.drep.totalVotes).toBe(2);
    expect(resultsByGroup.pool.totalVotes).toBe(2);
    expect(proposalParticipation.voterCount.drep).toBe(2);
    expect(proposalParticipation.voterCount.pool).toBe(2);
  });
});
