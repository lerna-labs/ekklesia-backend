import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * FAQ Schema
 * Represents a frequently asked question in the voting system
 *
 * @typedef {Object} FAQ
 * @property {String} title - Title of the FAQ
 * @property {String} description - Description/answer content of the FAQ
 * @property {String} category - Category of the FAQ ("voter" or "proposer")
 * @property {Boolean} is_live - Whether the FAQ is currently live/published
 * @property {Date} createdAt - Timestamp when the FAQ was created (immutable)
 * @property {Date} updatedAt - Timestamp when the FAQ was last updated
 */
const faqSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: ["voter", "proposer"],
      required: true,
    },
    is_live: {
      type: Boolean,
      default: false,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
    versionKey: false, // Remove __v field from documents
    toJSON: {
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Exclude id virtual when converting to JSON
    toObject: {
      transform: (doc, ret) => {
        delete ret.id;
        return ret;
      },
    }, // Exclude id virtual when converting to plain objects
  }
);

// Indexes for faster queries
faqSchema.index({ title: 1 });
faqSchema.index({ description: 1 });
faqSchema.index({ category: 1 });
faqSchema.index({ is_live: 1 });

// Text index for search functionality
faqSchema.index({ title: "text", description: "text" });

// Pre-save middleware to update the updatedAt field
faqSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const FAQ = mongoose.model("FAQ", faqSchema);
export { FAQ };
