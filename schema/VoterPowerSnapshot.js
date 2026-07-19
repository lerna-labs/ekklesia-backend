import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * VoterPowerSnapshot
 *
 * Per-voter voting power for a given ballot. Single source of truth for
 * "how much weight does Alice carry on ballot X" — group totals are
 * derived by aggregation on read.
 *
 * Three writers, distinguished by the `source` field:
 *   - "script"   — synthesized live by the validation script on a read
 *                  (rare; doesn't normally persist, but tests may write it)
 *   - "snapshot" — written by crons/15minVotingPower.js while the
 *                  ballot's voting window is open. Provisional.
 *   - "uploaded" — admin uploaded via POST /api/v1/admin/ballots/:id/voting-power.
 *                  Authoritative; cron skips the ballot once any
 *                  uploaded rows exist (gated by Ballot.votingPowerSource).
 *
 * Re-uploads atomically replace all rows for the ballot. The raw upload
 * payload is archived in ImportedBallotPayload for audit recovery.
 *
 * Voting-power is stored as Number (lovelace). JS Number safely
 * represents integers up to 2^53 (~9e15) — fine for any individual
 * voter's lovelace value (whale shares stay well under). Per-ballot
 * SUMs above ~9e15 see the lowest few hundred lovelace round; invisible
 * at demo + governance scale.
 */
const voterPowerSnapshotSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      ref: 'Ballot',
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    voterGroup: {
      type: String,
      enum: ['drep', 'pool', 'stake'],
      required: true,
    },
    votingPower: {
      type: Number,
      required: true,
      default: 0,
    },
    source: {
      type: String,
      enum: ['script', 'snapshot', 'uploaded'],
      required: true,
    },
    computedAt: {
      type: Date,
      default: Date.now,
    },
    computedBy: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// One row per (ballot, voter). Re-runs of the cron upsert; the admin
// upload deletes-then-inserts, so the unique index is preserved.
voterPowerSnapshotSchema.index({ ballotId: 1, userId: 1 }, { unique: true });
// Group rollups read by (ballotId, voterGroup).
voterPowerSnapshotSchema.index({ ballotId: 1, voterGroup: 1 });

const VoterPowerSnapshot = mongoose.model('VoterPowerSnapshot', voterPowerSnapshotSchema);
export { VoterPowerSnapshot };
