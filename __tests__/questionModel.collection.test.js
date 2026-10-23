/**
 * Integration test: the Question model reads and writes the existing
 * `proposals` collection, and refs from Comment, Result and Vote resolve.
 * Requires MongoDB. Uses MONGODB_URI_TEST or MONGODB_URI; skipped when neither is set.
 */

import mongoose from 'mongoose';
import { Question } from '../schema/Question.js';
import { Comment } from '../schema/Comment.js';
import { Result } from '../schema/Result.js';
import { Vote } from '../schema/Vote.js';

const mongoUri = process.env.MONGODB_URI_TEST || process.env.MONGODB_URI;
const describeFn = mongoUri ? describe : describe.skip;

const TAG = 'question-model-collection-test';

describeFn('Question model (mongo)', () => {
  const ballotId = new mongoose.Types.ObjectId();
  const created = [];

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
  });

  afterAll(async () => {
    const ids = created.map((q) => q._id);
    await Vote.deleteMany({ proposalId: { $in: ids } });
    await Result.deleteMany({ proposalId: { $in: ids } });
    await Comment.deleteMany({ proposalId: { $in: ids } });
    await mongoose.connection.collection('proposals').deleteMany({ _id: { $in: ids } });
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test('is registered as Question on the proposals collection', () => {
    expect(Question.modelName).toBe('Question');
    expect(Question.collection.collectionName).toBe('proposals');
    expect(mongoose.modelNames()).not.toContain('Proposal');
  });

  test('reads a document written to the raw proposals collection', async () => {
    const _id = new mongoose.Types.ObjectId();
    created.push({ _id });
    await mongoose.connection.collection('proposals').insertOne({
      _id,
      ballotId,
      title: `${TAG} legacy`,
      voteType: 'default',
    });
    const found = await Question.findById(_id).lean();
    expect(found).not.toBeNull();
    expect(found.title).toBe(`${TAG} legacy`);
    expect(String(found.ballotId)).toBe(String(ballotId));
  });

  test('writes through the model into the raw proposals collection', async () => {
    const q = new Question({ ballotId, title: `${TAG} written`, voteType: 'default' });
    await q.save({ validateBeforeSave: false });
    created.push(q);
    const raw = await mongoose.connection.collection('proposals').findOne({ _id: q._id });
    expect(raw).not.toBeNull();
    expect(raw.title).toBe(`${TAG} written`);
  });

  test('populate resolves the question from Comment, Result and Vote', async () => {
    const q = created.find((c) => c.title === `${TAG} written`);

    const comment = await Comment.collection.insertOne({
      proposalId: q._id,
      userId: 'u1',
      comment: 'c',
    });
    const result = await Result.collection.insertOne({ proposalId: q._id, results: {} });
    const vote = await Vote.collection.insertOne({
      userId: 'u1',
      ballotId,
      proposalId: q._id,
      vote: [],
    });

    const c = await Comment.findById(comment.insertedId).populate('proposalId').lean();
    const r = await Result.findById(result.insertedId).populate('proposalId').lean();
    const v = await Vote.findById(vote.insertedId).populate('proposalId').lean();

    for (const doc of [c, r, v]) {
      expect(doc.proposalId).not.toBeNull();
      expect(doc.proposalId.title).toBe(`${TAG} written`);
    }
  });
});
