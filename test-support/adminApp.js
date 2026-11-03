// Shared helpers for testing routes over HTTP with supertest. Lives outside
// __tests__/ so Jest does not collect it as a suite.
import { randomBytes } from 'crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

/**
 * Build an Express app without listening. `mountFn(app)` mounts the routers
 * under test. Mirrors the parsers in server.js.
 */
export function buildApp(mountFn) {
  const app = express();
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());
  mountFn(app);
  return app;
}

/** Sign an HS256 session token the way routes/api/v0/session.js does. */
export function mintToken({ userId, secret, extraClaims = {} }) {
  return jwt.sign({ userId, ...extraClaims }, secret, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
}

let activeDbName = null;

/**
 * Connect to MONGODB_URI_TEST using a database name unique to this call.
 * Throws when the variable is unset so a suite cannot pass without Mongo.
 */
export async function connectTestDb() {
  const uri = process.env.MONGODB_URI_TEST;
  if (!uri) throw new Error('MONGODB_URI_TEST must be set for tests that use Mongo');
  activeDbName = `ekklesia_test_${randomBytes(8).toString('hex')}`;
  await mongoose.connect(uri, { dbName: activeDbName });
  return activeDbName;
}

/** Drop the database created by connectTestDb and disconnect. */
export async function disconnectTestDb() {
  if (mongoose.connection.readyState === 1 && activeDbName) {
    await mongoose.connection.dropDatabase();
  }
  activeDbName = null;
  await mongoose.disconnect();
}
