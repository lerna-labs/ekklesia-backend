import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Ballot Schema
 * Represents a registered ballot in the voting system
 *
 * @typedef {Object} Ballot
 * @property {String} title - Title of the ballot
 * @property {String} description - Description of the ballot
 * @property {String} ipfsHash - IPFS hash of the ballot metadata (optional, null if not stored on IPFS)
 * @property {String} voterType - Display label for eligible voters (e.g., 'stake', 'drep', 'pool', 'any'). Human-readable; the authoritative role + power-source declaration lives in `voterGroups`.
 * @property {Array<{group: String, powerSource: String}>} voterGroups - Per-group eligibility + power-source declaration. `group` is one of "drep" / "pool" / "stake"; `powerSource` is one of Hydra's RoleWeighting values ("CredentialBased" / "StakeBased" / "PledgeBased"), subject to the valid-combinations rule (stake → StakeBased only; drep → CredentialBased or StakeBased; pool → CredentialBased / StakeBased / PledgeBased). hydraPrepare.js translates this array into Hydra's `roleWeighting` object at /prepare time.
 * @property {String} voterDescription - Human-readable description of eligible voters
 * @property {Boolean} voteWeighted - Whether the voting is weighted (default: false) - needed for UI displays mainly
 * @property {Date} votePeriodStart - Start date and time of the voting period
 * @property {Boolean} voteFilters - Whether filtering options are enabled for this ballot (default: false)
 * @property {Date} votePeriodEnd - End date and time of the voting period
 * @property {String} voteAuthorityId - ID of the voting authority managing this ballot
 * @property {String} voteAuthorityAddress - Blockchain address of the voting authority
 * @property {Date} proposalPeriodStart - Start date and time for submitting proposals
 * @property {Date} proposalPeriodEnd - End date and time for submitting proposals
 * @property {String} resultTxHash - Token for the result transaction (null if not finalized)
 * @property {String} voterValidationScript - Script used to validate voters (default: voterValidationAlwaysTrue.js)
 * @property {String} rollupScript - Script used to calculate voting results (default: rollupBallot.js)
 * @property {String} startupScript - Script used to start the ballot (default: startupBallot.js)
 * @property {Date} startupAt - Timestamp when the ballot was started (optional, null if not started)
 * @property {String} status - Current ballot status: "upcoming", "live", or "closed" (default: "upcoming")
 * @property {Date} createdAt - Timestamp when the ballot was created (immutable)
 * @property {Date} updatedAt - Timestamp when the ballot was last updated
 */
const ballotSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    ipfsHash: {
      type: String,
      required: false,
      default: null, // Optional field for IPFS hash
    },
    voterType: {
      type: String,
      required: true,
    },
    // Per-group eligibility + power source. Array so a single ballot
    // can declare, e.g., "DReps by delegated voting power AND SPOs by
    // pledge" in one shot. hydraPrepare.js translates this into Hydra's
    // roleWeighting object at /prepare time. Valid (group, powerSource)
    // combinations are enforced by the CompiledBallot validator:
    //   drep  → CredentialBased | StakeBased
    //   pool  → CredentialBased | StakeBased | PledgeBased
    //   stake → StakeBased
    voterGroups: {
      type: [
        {
          _id: false,
          group: {
            type: String,
            enum: ["drep", "pool", "stake"],
            required: true,
          },
          powerSource: {
            type: String,
            enum: ["CredentialBased", "StakeBased", "PledgeBased"],
            required: true,
          },
          // Optional per-group eligibility criteria. Validator-
          // interpreted; the only group with requirements support
          // today is `stake`, which accepts:
          //   mustExist: boolean
          //     — stake address seen on chain (account_info returns
          //       a row OR account_utxos non-empty). Default true.
          //   allowedPools: string[]
          //     — voter must be delegated to a pool in this allow-
          //       list. Omit / null = any pool accepted.
          //   tokenHoldings: Array<{ policyId, assetName?, minQuantity }>
          //     — voter must hold ≥ minQuantity of each entry.
          //       assetName absent = any asset under the policy.
          // Drep + pool groups ignore this field for now; their
          // requirement surface is the existing per-group validator.
          requirements: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
          },
        },
      ],
      default: [],
    },
    voterDescription: {
      type: String,
      required: true,
    },
    voteWeighted: {
      type: Boolean,
      default: false,
      required: true,
    },
    votePeriodStart: {
      type: Date,
      required: true,
    },
    voteFilters: {
      type: Boolean,
      default: false,
      required: true,
    },
    votePeriodEnd: {
      type: Date,
      required: true,
    },
    voteAuthorityId: {
      type: String,
      required: true,
    },
    voteAuthorityAddress: {
      type: String,
      required: true,
    },
    proposalPeriodStart: {
      type: Date,
      required: true,
    },
    proposalPeriodEnd: {
      type: Date,
      required: true,
    },
    resultTxHash: {
      default: null,
      type: String,
    },
    voterValidationScript: {
      type: String,
      default: "voterValidationAlwaysTrue.js",
      required: true,
    },
    rollupScript: {
      type: String,
      default: "rollupBallot.js",
      required: true,
    },
    startupScript: {
      type: String,
      default: "startupBallot.js",
      required: true,
    },
    startupAt: {
      type: Date,
      required: false,
      default: null,
    },
    status: {
      type: String,
      enum: ["upcoming", "live", "closed"],
      default: "upcoming",
      required: true,
    },
    source: {
      type: String,
      enum: ["legacy", "hydra"],
      default: "legacy",
      required: true,
    },
    hydraEndpoint: {
      type: String,
      default: null,
    },
    hydraHeadId: {
      type: String,
      default: null,
    },
    // Raw Hydra head state, mirrored from /head-info. Distinct from
    // `status` above, which is the user-facing ballot lifecycle.
    hydraHeadStatus: {
      type: String,
      enum: [
        null,
        "Idle",
        "Initializing",
        "Open",
        "Closing",
        "Closed",
        "Final",
        "FanoutPossible",
      ],
      default: null,
    },
    ballotCid: {
      type: String,
      default: null,
    },
    instancePolicyId: {
      type: String,
      default: null,
    },
    // Asset names (hex) produced by Hydra /prepare. The (600) definition
    // token is never spent; the (601) instance token gets committed into
    // the head at /start and spent at /finalize.
    definitionAssetName: {
      type: String,
      default: null,
    },
    instanceAssetName: {
      type: String,
      default: null,
    },
    // L1 tx hash from Hydra /prepare. Recorded so operators can monitor
    // confirmation on an explorer before proceeding to /start — the commit
    // UTxOs produced by /prepare need to be visible on-chain first.
    prepareTxHash: {
      type: String,
      default: null,
    },
    prepareTxSubmittedAt: {
      type: Date,
      default: null,
    },
    // UTxO refs Hydra returned in `commitUtxos` — what /start needs.
    commitUtxos: {
      type: Array,
      default: [],
    },
    // Slot at which the mint policy locks (== voting window open).
    timelockSlot: {
      type: Number,
      default: null,
    },
    // 28-byte blake2b_256(namespace).slice(0,28) as hex — shared across
    // (600) and (601) asset names.
    ballotFingerprint: {
      type: String,
      default: null,
    },
    provisionalResultsEnabled: {
      type: Boolean,
      default: false,
    },
    provisionalResultsConfig: {
      type: Object,
      default: null,
    },

    // Authority for this ballot's per-voter voting power. See
    // .claude/plans/violet-clever-noether.md for the full design.
    //
    //   "script"    — recompute live on every read (small ballots only)
    //   "snapshot"  — cron writes per-voter rows by calling the script.
    //                 Provisional / best-effort. Default for new ballots.
    //   "uploaded"  — admin uploaded an authoritative per-voter snapshot.
    //                 Scripts are no longer called for this ballot.
    //
    // Transition to "uploaded" via POST /api/v1/admin/ballots/:id/voting-power.
    // Re-uploadable for corrections; each upload is archived to
    // ImportedBallotPayload.
    votingPowerSource: {
      type: new Schema(
        {
          type: {
            type: String,
            enum: ["script", "snapshot", "uploaded"],
            default: "snapshot",
          },
          scriptName: { type: String, default: null },
          uploadedAt: { type: Date, default: null },
          uploadedBy: { type: String, default: null },
          uploadCid: { type: String, default: null },
        },
        { _id: false }
      ),
      default: () => ({ type: "snapshot" }),
    },

    // Origin of the ballot definition when imported from a proposals
    // module (push via API key) or uploaded as a compiled JSON file by
    // an admin. Null for scaffold-created or legacy ballots.
    //
    // `importMethod` distinguishes push (API key, proposals module owns
    // the transform) from upload (admin JWT, admin owns the file).
    //
    // Upsert key: (moduleId, externalBallotId) — the proposals module
    // can re-push updates up until the ballot goes live.
    proposalSource: {
      moduleId: { type: String, default: null },
      moduleUrl: { type: String, default: null },
      externalBallotId: { type: String, default: null },
      version: { type: String, default: null },
      importedAt: { type: Date, default: null },
      importMethod: {
        type: String,
        enum: [null, "push", "upload"],
        default: null,
      },
      importedBy: { type: String, default: null }, // admin userId or ApiKey.keyPrefix
    },

    // Dynamic sort/filter dimensions. Declared once per ballot so the
    // frontend can render filter UIs without hardcoding ballot-type
    // logic. Proposals reference these keys on their
    // externalProposal.snapshot.facets map. Once the ballot goes live,
    // the facets array is frozen with everything else.
    //
    // Rules (enforced by helper/facets/validate.js at import time):
    //   - option strings must not contain `,` (CSV is the wire format)
    //   - multi: true implies sortable: false
    //   - at most one facet may declare defaultSort
    //   - proposals can only carry facet keys declared here
    facets: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, required: true },
          type: {
            type: String,
            enum: ["enum", "number", "string", "boolean", "date"],
            required: true,
          },
          multi: { type: Boolean, default: false },
          options: { type: [String], default: [] },
          unit: { type: String, default: null },
          sortable: { type: Boolean, default: false },
          filterable: { type: Boolean, default: true },
          defaultSort: {
            type: String,
            enum: [null, "asc", "desc"],
            default: null,
          },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Include virtuals when converting to JSON, exclude id virtual
    toObject: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Include virtuals when converting to plain objects, exclude id virtual
  }
);

// Indexes for faster queries
ballotSchema.index({ title: 1 });
ballotSchema.index({ voterType: 1 });
ballotSchema.index({ source: 1 });

const Ballot = mongoose.model("Ballot", ballotSchema);
export { Ballot };
