import { Vote } from "../schema/Vote.js";
import { Ballot } from "../schema/Ballot.js";
import { Proposal } from "../schema/Proposal.js";

// !! NEEDS REWRITE !!
// returns all votes for a given voterId, ballotId, or voteType = pending
// if voteType is pending, it will return all votes that are pending
// if voteType is submitted, it will return all votes that are submitted
export async function getVotes(
  voterId = false,
  ballotId = false,
  voteType = false,
  voteLabels = false
) {
  // build voteSelect object
  const voteSelect = {};
  // add voterId
  if (voterId) {
    voteSelect.voterId = voterId;
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
  const votes = await Vote.find(voteSelect).select("value proposalId ballotId");

  // create array of individual ballotIds
  const ballotIds = votes.map((vote) => vote.ballotId);
  // get all ballots for the votes
  const ballots = await Ballot.find({
    _id: { $in: ballotIds },
  }).select("_id name description votePeriodStart votePeriodEnd");
  const plainBallots = ballots.map((ballot) =>
    ballot.toObject({ virtuals: true })
  );

  // create array of individual proposalIds
  const proposalIds = votes.map((vote) => vote.proposalId);
  // get all proposals for the votes
  const proposals = await Proposal.find({
    _id: { $in: proposalIds },
  })
    .select("_id name ballotId voteOptions data")
    .lean();

  // build data
  for (let ballot of plainBallots) {
    // add proposals to ballot object
    ballot.proposals = proposals.filter(
      (proposal) => proposal.ballotId.toString() === ballot._id.toString()
    );
    // add votes to each proposal object
    ballot.proposals.forEach((proposal) => {
      proposal.vote = votes.filter(
        (vote) => String(vote.proposalId) === String(proposal._id)
      );
      // convert vote to label if voteLabels is true
      if (voteLabels) {
        proposal.vote = proposal.voteOptions.find(
          (el) => el.value === proposal.vote[0].value
        );
      }
    });
  }

  return plainBallots;
}

// returns the pending vote count for a voterId on active ballots
export async function getPendingVoteCount(voterId) {
  const pendingVotes = await Vote.find({
    voterId,
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
  }).select("_id name description votePeriodStart votePeriodEnd");

  // Convert to plain objects to access virtual properties
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

// returns the submitted votes for a voterId on all ballots a voter has voted on based on the transaction collection
export async function getSubmittedVotes(voterId) {
  // get transactions for the voterId, but only the ones with status submitted and only the last one per ballotId
  const votes = await Vote.find({
    voterId,
    submittedAt: { $ne: null },
    $expr: {
      $lt: [
        {
          $subtract: [{ $toLong: "$updatedAt" }, { $toLong: "$submittedAt" }],
        },
        1000,
      ],
    },
  }).select("ballotId submittedValue proposalId");

  // create array of individual ballotIds and remove duplicates
  const ballotIds = [...new Set(votes.map((vote) => vote.ballotId))];

  // get all ballots for the votes
  const ballots = await Ballot.find({
    _id: { $in: ballotIds },
  }).select("_id name description votePeriodStart votePeriodEnd");
  const plainBallots = ballots.map((ballot) =>
    ballot.toObject({ virtuals: true })
  );
  // create array of individual proposalIds of all votes
  const proposalIds = [...new Set(votes.map((vote) => vote.proposalId))];
  // get all proposals for the votes
  const proposals = await Proposal.find({
    _id: { $in: proposalIds },
  })
    .select("_id name ballotId data voteOptions")
    .lean();
  // build data
  for (let ballot of plainBallots) {
    // add proposals to ballot object
    ballot.proposals = proposals.filter(
      (proposal) => proposal.ballotId.toString() === ballot._id.toString()
    );
    // add votes to each proposal object
    ballot.proposals.forEach((proposal) => {
      // return submitted value from votes array
      proposal.vote = votes.find(
        (vote) => String(vote.proposalId) === String(proposal._id)
      ).submittedValue;

      // convert vote to label if voteLabels is true
      proposal.voteLabel = proposal.voteOptions.find(
        (el) => el.value === proposal.vote
      ).label;

      proposal.description = proposal.data?.description;
      // remove data.voteOptions from proposal object
      delete proposal.data;
    });
  }

  return plainBallots;
}
