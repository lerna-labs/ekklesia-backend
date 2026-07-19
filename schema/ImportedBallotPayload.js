import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * ImportedBallotPayload
 *
 * Audit trail for every successful ballot import (push from a
 * proposals module OR upload by an admin). Indefinite retention —
 * volume is low (one doc per import) and these records are the
 * authoritative "what did the module/admin actually send us" log.
 *
 * Stored separately from Ballot so the compiled JSON stays untouched
 * even after the writer normalizes it onto Ballot + Proposal docs.
 */
const importedBallotPayloadSchema = new Schema(
  {
    ballotId: {
      type: Schema.Types.ObjectId,
      ref: 'Ballot',
      required: true,
    },
    schemaVersion: {
      type: String,
      required: true,
    },
    importMethod: {
      type: String,
      enum: ['push', 'upload'],
      required: true,
    },
    // Who sent it. For "push" this is the ApiKey.keyPrefix; for
    // "upload" it's the admin userId. Kept as a string so we don't
    // care which source system issued the id.
    importedBy: {
      type: String,
      required: true,
    },
    // Frozen copy of the source block from the payload, for quick
    // filtering without parsing `payload`.
    source: {
      moduleId: { type: String, default: null },
      moduleUrl: { type: String, default: null },
      externalBallotId: { type: String, default: null },
      version: { type: String, default: null },
    },
    // SHA-256 hex of the canonical (JSON.stringified) payload. Cheap
    // de-dup check for "did we already see this exact import?".
    checksum: {
      type: String,
      required: true,
    },
    // The full CompiledBallot as received. Mongoose Object keeps the
    // shape verbatim — no silent re-keying.
    payload: {
      type: Object,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

importedBallotPayloadSchema.index({ ballotId: 1, createdAt: -1 });
importedBallotPayloadSchema.index({ checksum: 1 });
importedBallotPayloadSchema.index({
  'source.moduleId': 1,
  'source.externalBallotId': 1,
});

const ImportedBallotPayload = mongoose.model('ImportedBallotPayload', importedBallotPayloadSchema);
export { ImportedBallotPayload };
