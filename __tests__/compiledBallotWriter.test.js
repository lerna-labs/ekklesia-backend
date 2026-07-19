/**
 * Integration test for compiledBallot writer.
 * Requires MongoDB. Same URI resolution as aggregateVotes.grouped.test.js.
 * Skipped automatically when no URI can be resolved.
 */

import path from 'path';
import { fileURLToPath } from 'url';
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
import { Ballot } from '../schema/Ballot.js';
import { Proposal } from '../schema/Proposal.js';
import { ImportedBallotPayload } from '../schema/ImportedBallotPayload.js';
import { writeCompiledBallot, CompiledBallotWriteError } from '../helper/compiledBallot/writer.js';

const mongoUri = getMongoUri();
const describeFn = mongoUri ? describe : describe.skip;

const MODULE_ID = 'writer-test-module';
const EXT_ID_PREFIX = 'writer-test-ballot-';

function basePayload(extId) {
  return {
    schemaVersion: '1',
    source: {
      moduleId: MODULE_ID,
      moduleUrl: 'https://example.test/',
      externalBallotId: extId,
      version: 'v1',
    },
    ballot: {
      title: 'Writer integration ballot',
      description: 'created by compiledBallotWriter.test.js',
      voterType: 'drep',
      voterDescription: 'Test DReps',
      voteWeighted: true,
      voteFilters: false,
      votePeriodStart: new Date(Date.now() + 60_000).toISOString(),
      votePeriodEnd: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      proposalPeriodStart: new Date(Date.now() - 86_400_000).toISOString(),
      proposalPeriodEnd: new Date(Date.now() + 30_000).toISOString(),
      voteAuthorityId: 'auth-writer-test',
      voteAuthorityAddress: 'addr_test_writer',
    },
    facets: [
      {
        key: 'category',
        label: 'Category',
        type: 'enum',
        multi: true,
        options: ['education', 'infrastructure'],
        sortable: false,
        filterable: true,
      },
    ],
    proposals: [
      {
        title: 'P1',
        voteType: 'default',
        voteOptions: [
          { id: 1, cost: 1, label: 'Yes' },
          { id: 2, cost: 1, label: 'No' },
        ],
        externalProposal: {
          id: 'ext-p1',
          url: 'https://example.test/p/1',
          snapshot: {
            title: 'P1',
            summary: 'Snapshot summary 1',
            authors: ['Alice'],
            version: '1',
            facets: { category: 'education' },
          },
        },
      },
    ],
  };
}

async function cleanup() {
  const ballots = await Ballot.find({
    'proposalSource.moduleId': MODULE_ID,
  }).select('_id');
  const ids = ballots.map((b) => b._id);
  if (ids.length) {
    await Proposal.deleteMany({ ballotId: { $in: ids } });
    await ImportedBallotPayload.deleteMany({ ballotId: { $in: ids } });
    await Ballot.deleteMany({ _id: { $in: ids } });
  }
}

describeFn('compiledBallot.writer (mongo)', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test('creates ballot + proposals + audit doc on first import', async () => {
    const payload = basePayload(`${EXT_ID_PREFIX}create`);
    const res = await writeCompiledBallot(payload, {
      method: 'upload',
      importedBy: 'admin-test-1',
    });
    expect(res.created).toBe(true);
    expect(res.proposalsImported).toBe(1);

    const ballot = await Ballot.findById(res.ballotId).lean();
    expect(ballot.proposalSource.moduleId).toBe(MODULE_ID);
    expect(ballot.proposalSource.importMethod).toBe('upload');
    expect(ballot.facets).toHaveLength(1);

    const proposals = await Proposal.find({ ballotId: ballot._id }).lean();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].externalProposal.id).toBe('ext-p1');

    const audits = await ImportedBallotPayload.find({ ballotId: ballot._id }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].importMethod).toBe('upload');
  });

  test('re-import replaces proposal set and appends a new audit row', async () => {
    const extId = `${EXT_ID_PREFIX}reimport`;
    const first = await writeCompiledBallot(basePayload(extId), {
      method: 'push',
      importedBy: 'apikeyPrefix-xyz',
    });
    expect(first.created).toBe(true);

    const p2 = basePayload(extId);
    p2.proposals = [
      {
        title: 'P2-new',
        voteType: 'default',
        voteOptions: [
          { id: 1, cost: 1, label: 'Yes' },
          { id: 2, cost: 1, label: 'No' },
        ],
        externalProposal: {
          id: 'ext-p2',
          snapshot: {
            title: 'P2-new',
            summary: 'second import',
            authors: [],
            version: '2',
            facets: { category: 'infrastructure' },
          },
        },
      },
    ];
    const second = await writeCompiledBallot(p2, {
      method: 'push',
      importedBy: 'apikeyPrefix-xyz',
    });
    expect(second.created).toBe(false);
    expect(second.ballotId).toBe(first.ballotId);

    const proposals = await Proposal.find({ ballotId: first.ballotId }).lean();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].externalProposal.id).toBe('ext-p2');

    const audits = await ImportedBallotPayload.find({ ballotId: first.ballotId }).lean();
    expect(audits).toHaveLength(2);
  });

  test('refuses re-import when ballot is live', async () => {
    const extId = `${EXT_ID_PREFIX}frozen`;
    const first = await writeCompiledBallot(basePayload(extId), {
      method: 'upload',
      importedBy: 'admin-test-2',
    });
    await Ballot.updateOne({ _id: first.ballotId }, { $set: { status: 'live' } });

    await expect(
      writeCompiledBallot(basePayload(extId), {
        method: 'upload',
        importedBy: 'admin-test-2',
      }),
    ).rejects.toThrow(CompiledBallotWriteError);
  });
});
