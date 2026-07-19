// Stake-voter validation script. For scaffold / demo usage this just
// re-exports the UserCache-backed snapshot validator — a validated
// UserCache row for the voter on this ballot is the signal that
// they're eligible to vote with their cached stake power.
//
// For real-network stake ballots that need to enumerate stake from
// chain data directly, swap this for a Koios-backed implementation
// (see voterValidationDReps.js for the enumeration pattern).

export { validateVoter, allowedVoterCount, getTotalWeight } from './voterValidationSnapshot.js';

export { computeFromUserCache as computePerVoterPower } from '../helper/votingPower/computeFromUserCache.js';
