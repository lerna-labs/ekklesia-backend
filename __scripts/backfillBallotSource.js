// One-shot, idempotent backfill: stamp source: "legacy" on every existing
// Ballot that doesn't already have a source set. Safe to re-run.
//
// Usage: NODE_ENV=development node __scripts/backfillBallotSource.js

import process from 'process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { Ballot } from '../schema/Ballot.js';
import { connectToDatabase, disconnectFromDatabase } from '../helper/dbManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: join(__dirname, '..', `.env.${env}`) });

await connectToDatabase();

const result = await Ballot.updateMany(
  { $or: [{ source: { $exists: false } }, { source: null }] },
  { $set: { source: 'legacy' } },
);

console.log(`Backfill complete: matched=${result.matchedCount} modified=${result.modifiedCount}`);

await disconnectFromDatabase();
process.exit(0);
