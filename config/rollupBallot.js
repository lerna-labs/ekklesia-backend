import { Ballot } from '../schema/Ballot.js';

// !! needs to fetch final allowed voter count and store it in the ballot

export async function rollupBallot(ballotId) {
  // get ballot
  const ballot = await Ballot.findById(ballotId);
  if (!ballot) {
    throw new Error('Ballot not found');
  }

  // set resultBeacon
  const update = await Ballot.updateOne(
    { _id: ballotId },
    {
      $set: {
        resultBeaconToken: 'ROLLEDUP',
      },
    },
  );
  if (update.modifiedCount === 0) {
    throw new Error('Failed to update ballot');
  }
}
