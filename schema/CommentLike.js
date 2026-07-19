import mongoose from 'mongoose';
const { Schema } = mongoose;

const commentLikeSchema = new Schema(
  {
    commentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Comment',
      required: true,
    },
    userId: {
      type: String,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

commentLikeSchema.index({ commentId: 1, userId: 1 }, { unique: true });
commentLikeSchema.index({ commentId: 1 });

const CommentLike = mongoose.model('CommentLike', commentLikeSchema);
export { CommentLike };
