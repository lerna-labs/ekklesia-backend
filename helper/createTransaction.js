import { Vote } from '../schema/Vote.js';
import { Transaction } from '../schema/Transaction.js';
import { createVoterTree } from '../helper/createVoterTree.js';

/**
 * Creates or updates a transaction record for submitting votes
 *
 * @param {string} userId - The ID of the voter submitting votes
 * @param {string} ballotId - The ID of the ballot being voted on
 * @returns {Object} A cleaned transaction object containing votes and merkle root
 * @throws {Error} If no votes are found for the specified voter and ballot
 *
 * @description
 * This function performs the following operations:
 * 1. Retrieves all votes for the specified voter and ballot
 * 2. Cleans the vote objects by removing metadata fields
 * 3. Creates a merkle tree from the vote data for verification
 * 4. Creates or updates a transaction record in the database
 * 5. Returns a cleaned transaction object for client consumption
 *
 * The returned transaction object contains the ballot ID, voter ID,
 * cleaned vote objects, and the merkle root hash for verification.
 */
export async function createTransaction(userId, ballotId) {
  // get votes for this ballot
  const votes = await Vote.find({
    userId,
    ballotId,
  }).sort({ _id: -1 });
  if (votes.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'no votes to submit',
    });
  }
  // cleanup vote object
  // maybe stupid because it has to be added for the transaction object
  const cleanVotes = votes.map((vote) => {
    const voteObj = vote.toObject();
    delete voteObj._id;
    delete voteObj.userId;
    delete voteObj.ballotId;
    delete voteObj.createdAt;
    delete voteObj.updatedAt;
    delete voteObj.submittedAt;
    delete voteObj.submittedVote;
    return voteObj;
  });

  // Create merkle tree from votes
  const voteData = {
    ballotId,
    userId,
    votes: cleanVotes,
  };

  const merkleTree = createVoterTree(voteData);

  // store transaction in db
  const transaction = await Transaction.findOneAndUpdate(
    { userId, ballotId, status: 'created' },
    {
      $set: {
        votes: cleanVotes,
        merkleRoot: merkleTree.rootHash,
      },
    },
    { upsert: true, new: true },
  );

  // cleanup transaction object
  const transactionResponse = transaction.toObject();
  delete transactionResponse.status;
  delete transactionResponse._id;

  return transactionResponse;
}
