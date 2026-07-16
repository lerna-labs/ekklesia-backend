import { MerkleTree } from 'merkletreejs';
import crypto from 'crypto';

/**
 * Creates a Merkle tree from votes data and returns the root hash
 * @param {Object} data - The vote data containing ballotId, userId, and votes
 * @returns {Object} - Object containing the Merkle root hash and basic tree info
 */
export function createVoterTree(data) {
  const { ballotId, userId, votes } = data;

  if (!votes || !Array.isArray(votes) || votes.length === 0) {
    throw new Error('Invalid votes data');
  }

  // Create leaf data for each vote
  const leaves = votes.map((vote) => {
    // Create a standardized representation of the vote to hash
    // Use the userId from the parent object if not present in vote
    const voteData = {
      proposalId: vote.proposalId,
      userId: vote.userId || userId, // Use vote.userId if available, otherwise use the parent userId
      vote: vote.vote,
      ballotId,
    };

    // Convert to buffer for hashing
    return Buffer.from(JSON.stringify(voteData));
  });

  // Create a hash function using SHA-256
  const hashFunction = (data) => {
    return crypto.createHash('sha256').update(data).digest();
  };

  // Create the Merkle tree
  const tree = new MerkleTree(leaves, hashFunction, {
    sortPairs: true, // Sort pairs before hashing for deterministic results
    hashLeaves: true, // Hash the leaf data
  });

  // Get the root hash
  const rootHash = tree.getHexRoot();

  return {
    rootHash,
    ballotId,
    userId,
    getSerializedTree: () => ({
      rootHash,
      ballotId,
      leavesCount: leaves.length,
      treeDepth: Math.ceil(Math.log2(leaves.length)),
    }),
  };
}
