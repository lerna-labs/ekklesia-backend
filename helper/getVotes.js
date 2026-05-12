import { Vote } from "../schema/Vote.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";

// !! NEEDS REWRITE !!
// returns all votes for a given userId, ballotId, or voteType = pending
// if voteType is pending, it will return all votes that are pending
// if voteType is submitted, it will return all votes that are submitted
export async function getVotes(
  userId = false,
  ballotId = false,
  voteType = false,
  voteLabels = false
) {
  // build voteSelect object
  const voteSelect = {};
  // add userId
  if (userId) {
    voteSelect.userId = userId;
  }
  // add ballotId
  if (ballotId) {
    // Convert string ballotId to ObjectId if it's a string
    voteSelect.ballotId = ballotId;
  }

  if (voteType === "pending") {
    voteSelect.$or = [
      { submittedAt: null },
      {
        $expr: {
          $gt: [
            {
              $subtract: [
                { $toLong: "$updatedAt" },
                { $toLong: "$submittedAt" },
              ],
            },
            1000,
          ],
        },
      },
    ];
  }
  // fetch votes from the database
  const votes = await Vote.find(voteSelect).select("vote proposalId ballotId");

  // create array of individual ballotIds
  const ballotIds = votes.map((vote) => vote.ballotId);
  // get all ballots for the votes
  const ballots = await Ballot.find({
    _id: { $in: ballotIds },
  }).select("_id title description votePeriodStart votePeriodEnd status");
  const plainBallots = ballots.map((ballot) =>
    ballot.toObject({ virtuals: true })
  );

  // create array of individual proposalIds
  const proposalIds = votes.map((vote) => vote.proposalId);
  // get all proposals for the votes
  const proposals = await Proposal.find({
    _id: { $in: proposalIds },
  })
    .select("_id title ballotId voteOptions") // NOTE: This returned data and voteOptions before, but why
    .lean();

  // build data
  for (let ballot of plainBallots) {
    // add proposals to ballot object
    ballot.proposals = proposals.filter(
      (proposal) => proposal.ballotId.toString() === ballot._id.toString()
    );
    // add votes to each proposal object
    ballot.proposals.forEach((proposal) => {
      proposal.voteData = votes.filter(
        (vote) => String(vote.proposalId) === String(proposal._id)
      );

      const voteIds = proposal.voteData[0].vote;
      // convert vote to labels if voteLabels is true
      if (voteLabels) {
        proposal.vote = voteIds.map((voteId) => {
          const option = proposal.voteOptions.find(
            (el) => el.id === voteId
          );
          return option ? option.label : voteId;
        });
      }

      // remove data.voteOptions from proposal object
      delete proposal.voteOptions;

      // remove voteData from proposal object
      delete proposal.voteData;

      // TODO CLEANUP
      // convert vote to label if voteLabels is true
      // if (voteLabels) {
      //   proposal.vote = proposal.voteOptions.find(
      //     (el) => el.value === proposal.vote[0].value
      //   );
      // }
    });
  }

  return plainBallots;
}

// returns the pending vote count for a userId on active ballots
export async function getPendingVoteCount(userId) {
  const pendingVotes = await Vote.find({
    userId,
    $or: [
      { submittedAt: null },
      {
        $expr: {
          $gt: [
            {
              $subtract: [
                { $toLong: "$updatedAt" },
                { $toLong: "$submittedAt" },
              ],
            },
            1000,
          ],
        },
      },
    ],
  }).select("ballotId");

  // create array of individual ballotIds
  const ballotIds = pendingVotes.map((vote) => vote.ballotId);

  // get all ballots for the pending votes
  const ballots = await Ballot.find({
    _id: { $in: ballotIds },
  }).select("_id title description votePeriodStart votePeriodEnd voteWeighted status");

  // Convert to plain objects to access virtual properties
  // !! no longer needed because there are no virutals
  const plainBallots = ballots.map((ballot) =>
    ballot.toObject({ virtuals: true })
  );

  // Filter for only live ballots
  const liveBallots = plainBallots.filter((ballot) => ballot.status === "live");

  // Get the IDs of live ballots
  const liveBallotIds = liveBallots.map((ballot) => ballot._id.toString());

  // Filter pending votes to only those on live ballots
  const pendingVotesOnLiveBallots = pendingVotes.filter((vote) =>
    liveBallotIds.includes(vote.ballotId.toString())
  );

  return pendingVotesOnLiveBallots.length;
}

// returns the submitted votes for a userId on all ballots a voter has voted on based on the transaction collection
export async function getSubmittedVotes(userId) {
  // get transactions for the userId, but only the ones with status submitted and only the last one per ballotId
  const votes = await Vote.find({
    userId,
    submittedAt: { $ne: null },
    $expr: {
      $lt: [
        {
          $subtract: [{ $toLong: "$updatedAt" }, { $toLong: "$submittedAt" }],
        },
        1000,
      ],
    },
  }).select("ballotId submittedVote proposalId");

  // create array of individual ballotIds and remove duplicates
  const ballotIds = [...new Set(votes.map((vote) => vote.ballotId))];

  // get all ballots for the votes
  const ballots = await Ballot.find({
    _id: { $in: ballotIds },
  }).select("_id title description votePeriodStart votePeriodEnd");
  const plainBallots = ballots.map((ballot) =>
    ballot.toObject({ virtuals: true })
  );
  // create array of individual proposalIds of all votes
  const proposalIds = [...new Set(votes.map((vote) => vote.proposalId))];
  // get all proposals for the votes
  const proposals = await Proposal.find({
    _id: { $in: proposalIds },
  })
    .select("_id title ballotId data voteOptions")
    .lean();
  // build data
  for (let ballot of plainBallots) {
    // add proposals to ballot object
    ballot.proposals = proposals.filter(
      (proposal) => proposal.ballotId.toString() === ballot._id.toString()
    );
    // add votes to each proposal object
    ballot.proposals.forEach((proposal) => {
      // return submitted value from votes array (first element for single-option, else full array)
      const vote = votes.find(
        (v) => String(v.proposalId) === String(proposal._id)
      );
      proposal.vote = vote?.submittedVote?.[0] ?? vote?.submittedVote ?? null;

      // convert vote to label if voteLabels is true
      proposal.voteLabel = proposal.voteOptions.find(
        (el) => el.value === proposal.vote
      )?.label;

      // Lift summary/rationale out of `data` if a legacy vote payload
      // tucked them there; canonical Proposal fields take precedence.
      if (!proposal.summary && proposal.data?.summary) {
        proposal.summary = proposal.data.summary;
      }
      if (!proposal.rationale && proposal.data?.rationale) {
        proposal.rationale = proposal.data.rationale;
      }
      // remove data.voteOptions from proposal object
      delete proposal.data;
    });
  }

  return plainBallots;
}
