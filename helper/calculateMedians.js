/**
 * Calculate the median of an array of numbers
 * @param {number[]} values - Array of numbers sorted in ascending order
 * @returns {number|null} - The median value, or null if array is empty
 */
export function calculateMedian(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    // Even number of values: average the two middle values
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    // Odd number of values: return the middle value
    return sorted[mid];
  }
}

/**
 * Calculate the weighted median of vote values based on voting power
 * Uses cumulative weights to avoid creating large arrays
 * @param {Array} votes - Array of vote objects with submittedVote and userId
 * @param {Array} userCaches - Array of user cache objects with userId and votingPower
 * @param {number} lowerBound - Lower bound for valid vote values
 * @param {number} upperBound - Upper bound for valid vote values
 * @returns {number|null} - The weighted median value, or null if no valid votes
 */
export function calculateWeightedMedian(votes, userCaches, lowerBound, upperBound) {
  if (!votes || votes.length === 0) {
    return null;
  }

  // Create a map of userId to votingPower for quick lookup
  const votingPowerMap = new Map();
  userCaches.forEach((cache) => {
    votingPowerMap.set(cache.userId.toString(), cache.votingPower || 1);
  });

  // Collect votes with their weights
  const weightedVotes = [];

  votes.forEach((vote) => {
    if (!vote.submittedVote || vote.submittedVote.length === 0) {
      return;
    }

    // For scale votes, submittedVote is an array with a single value (the scale ID)
    const voteValue = vote.submittedVote[0];

    // Skip abstain votes
    if (voteValue === "abstain") {
      return;
    }

    // Convert to number and validate bounds
    const numericValue = Number(voteValue);
    if (isNaN(numericValue) || numericValue < lowerBound || numericValue > upperBound) {
      return;
    }

    // Get voting power for this voter (default to 1 if not found)
    const votingPower = votingPowerMap.get(vote.userId.toString()) || 1;

    weightedVotes.push({
      value: numericValue,
      weight: votingPower
    });
  });

  if (weightedVotes.length === 0) {
    return null;
  }

  // Sort by vote value
  weightedVotes.sort((a, b) => a.value - b.value);

  // Calculate total weight
  const totalWeight = weightedVotes.reduce((sum, vote) => sum + vote.weight, 0);

  // Find the median position (half of total weight)
  const medianPosition = totalWeight / 2;
  let cumulativeWeight = 0;

  // Find the value at the median position
  for (const vote of weightedVotes) {
    cumulativeWeight += vote.weight;
    if (cumulativeWeight >= medianPosition) {
      return vote.value;
    }
  }

  // Fallback (shouldn't reach here, but return last value)
  return weightedVotes[weightedVotes.length - 1].value;
}

/**
 * Calculate the simple median of vote values (one vote per voter)
 * @param {Array} votes - Array of vote objects with submittedVote
 * @param {number} lowerBound - Lower bound for valid vote values
 * @param {number} upperBound - Upper bound for valid vote values
 * @returns {number|null} - The median value, or null if no valid votes
 */
export function calculateSimpleMedian(votes, lowerBound, upperBound) {
  if (!votes || votes.length === 0) {
    return null;
  }

  // Extract vote values, filtering out abstain and invalid values
  const voteValues = [];

  votes.forEach((vote) => {
    if (!vote.submittedVote || vote.submittedVote.length === 0) {
      return;
    }

    // For scale votes, submittedVote is an array with a single value (the scale ID)
    const voteValue = vote.submittedVote[0];

    // Skip abstain votes
    if (voteValue === "abstain") {
      return;
    }

    // Convert to number and validate bounds
    const numericValue = Number(voteValue);
    if (isNaN(numericValue) || numericValue < lowerBound || numericValue > upperBound) {
      return;
    }

    voteValues.push(numericValue);
  });

  if (voteValues.length === 0) {
    return null;
  }

  return calculateMedian(voteValues);
}
