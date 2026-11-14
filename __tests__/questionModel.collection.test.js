/**
 * Integration test: the Question model reads and writes the existing
 * `proposals` collection, refs from Comment, Result and Vote resolve, and no
 * other model shares that collection.
 * Requires MongoDB. Same URI resolution as compiledBallotWriter.test.js.
 * Skipped automatically when no URI can be resolved.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

function getMongoUri() {
  if (process.env.MONGODB_URI_TEST || process.env.MONGODB_URI) {
    return process.env.MONGODB_URI_TEST || process.env.MONGODB_URI;
  }
  const database = process.env.MONGODB_DATABASE;
  if (!database) return null;
  const host = process.env.MONGODB_HOST || 'localhost';
  const port = process.env.MONGODB_PORT || '27017';
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const authSource = process.env.MONGODB_AUTH_SOURCE || 'admin';
  const dbName = process.env.MONGODB_DATABASE_TEST || `${database}_test`;
  let uri = 'mongodb://';
  if (username && password) {
    uri += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  uri += `${host}:${port}/${dbName}`;
  if (username && password) uri += `?authSource=${authSource}`;
  return uri;
}

import mongoose from 'mongoose';
import { Question } from '../schema/Question.js';
import { Comment } from '../schema/Comment.js';
import { Result } from '../schema/Result.js';
import { Vote } from '../schema/Vote.js';

const mongoUri = getMongoUri();
const describeFn = mongoUri ? describe : describe.skip;

const TAG = 'question-model-collection-test';
const proposals = () => mongoose.connection.collection('proposals');

describeFn('Question model (mongo)', () => {
  const ballotId = new mongoose.Types.ObjectId();
  const questionIds = [];

  async function newQuestion(label) {
    const q = new Question({ ballotId, title: `${TAG} ${label}`, voteType: 'default' });
    await q.save({ validateBeforeSave: false });
    questionIds.push(q._id);
    return q;
  }

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
  });

  afterAll(async () => {
    await Vote.deleteMany({ proposalId: { $in: questionIds } });
    await Result.deleteMany({ proposalId: { $in: questionIds } });
    await Comment.deleteMany({ proposalId: { $in: questionIds } });
    await proposals().deleteMany({ _id: { $in: questionIds } });
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test('is registered as Question on the proposals collection', () => {
    expect(Question.modelName).toBe('Question');
    expect(Question.collection.collectionName).toBe('proposals');
  });

  test('no model named Proposal is registered and every model owns its own collection', async () => {
    const schemaDir = path.join(__dirname, '..', 'schema');
    for (const file of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.js'))) {
      await import(pathToFileURL(path.join(schemaDir, file)).href);
    }
    expect(mongoose.modelNames()).not.toContain('Proposal');
    const byCollection = {};
    for (const name of mongoose.modelNames()) {
      const coll = mongoose.model(name).collection.collectionName;
      (byCollection[coll] ||= []).push(name);
    }
    for (const [coll, names] of Object.entries(byCollection)) {
      expect({ coll, names }).toEqual({ coll, names: [names[0]] });
    }
    expect(byCollection.proposals).toEqual(['Question']);
  });

  test('reads a document written to the raw proposals collection', async () => {
    const _id = new mongoose.Types.ObjectId();
    questionIds.push(_id);
    await proposals().insertOne({
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
    const q = await newQuestion('written');
    const raw = await proposals().findOne({ _id: q._id });
    expect(raw).not.toBeNull();
    expect(raw.title).toBe(`${TAG} written`);
  });

  test('populate resolves the question from Comment, Result and Vote', async () => {
    const q = await newQuestion('populated');

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
      expect(doc.proposalId.title).toBe(`${TAG} populated`);
    }
  });
});
