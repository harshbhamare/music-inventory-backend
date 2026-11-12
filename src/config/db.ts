/**
 * db.ts — Centralised MongoDB connection manager
 *
 * Design goals for Vercel serverless + MongoDB Atlas M0:
 *
 * 1. SINGLE connect() call per Node.js process lifetime (Mongoose readyState guard).
 * 2. PROMISE-LOCK prevents concurrent cold-start requests from each calling
 *    mongoose.connect() simultaneously — only the first one races to connect,
 *    every other concurrent caller awaits the same Promise.
 * 3. CONSERVATIVE pool settings that keep total connections well below the M0
 *    limit even with several warm serverless instances running in parallel:
 *      maxPoolSize: 5   (was 20)  — max 5 connections per serverless instance
 *      minPoolSize: 1   (was 5)   — keep at most 1 idle connection alive
 *      maxIdleTimeMS: 10_000      — release idle connections after 10 s
 * 4. autoIndex: false in production — never rebuild indexes on every connect.
 * 5. bufferCommands: false — fail fast instead of buffering ops while disconnected.
 */

import mongoose from 'mongoose';
import { ENV } from './env.js';

// ─── Module-level singletons ────────────────────────────────────────────────

let mongodReplSet: any = null;

/**
 * Promise-lock: if a connect() is already in progress on this Node.js instance
 * (e.g. two concurrent requests arrive during a cold start), subsequent callers
 * await this same Promise instead of firing a second mongoose.connect().
 */
let connectingPromise: Promise<typeof mongoose> | null = null;

/** Cached after the first successful connect – used by areTransactionsSupported(). */
let isReplicaSet = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the existing Mongoose instance if already connected,
 * otherwise establishes a new connection (with promise-lock for concurrency).
 */
export async function connectDB(): Promise<typeof mongoose> {
  // ── Fast path: already connected ──────────────────────────────────────────
  // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  if (mongoose.connection.readyState === 1) {
    console.log('[DB] Reusing existing MongoDB connection (readyState=1).');
    return mongoose;
  }

  // ── Connecting path: join the in-progress Promise ─────────────────────────
  // Handles the race where two concurrent requests both see readyState===0
  // before either has called mongoose.connect().
  if (connectingPromise) {
    console.log('[DB] Connection already in progress — awaiting existing connect Promise.');
    return connectingPromise;
  }

  // ── Cold-start path: initiate connection ───────────────────────────────────
  connectingPromise = _doConnect().finally(() => {
    connectingPromise = null; // release lock after connect resolves or rejects
  });

  return connectingPromise;
}

export function areTransactionsSupported(): boolean {
  return isReplicaSet;
}

export async function withTransaction<T>(
  work: (session: mongoose.ClientSession | null) => Promise<T>
): Promise<T> {
  if (!isReplicaSet) {
    return work(null);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) return; // nothing to disconnect

  console.log('[DB] Disconnecting from MongoDB…');
  await mongoose.disconnect();
  console.log('[DB] Disconnected.');

  if (mongodReplSet) {
    await mongodReplSet.stop();
    mongodReplSet = null;
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function _doConnect(): Promise<typeof mongoose> {
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  let uri = isTest ? (process.env.TEST_MONGODB_URI || '') : ENV.MONGODB_URI;

  // ── Resolve URI (production must have MONGODB_URI) ────────────────────────
  if (!uri) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new Error(
        '[DB_FATAL] MONGODB_URI environment variable is not set. ' +
        'Configure it in your Vercel project → Settings → Environment Variables.'
      );
    }

    // Development / CI fallback: spin up an in-memory replica set
    console.log('[DB] No MONGODB_URI — starting in-memory MongoDB Replica Set for local dev…');
    try {
      const { MongoMemoryReplSet } = await import('mongodb-memory-server');
      mongodReplSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
      });
      uri = mongodReplSet.getUri();
      console.log('[DB] In-memory MongoDB Replica Set ready.');
    } catch (err) {
      console.error('[DB] Failed to start MongoMemoryReplSet:', err);
      throw err;
    }
  }

  // ── Connection options tuned for Atlas M0 + Vercel serverless ─────────────
  //
  // M0 Free Tier limits:
  //   • 500 max connections total across ALL clients
  //   • Practically safe budget: ~100 app connections across all warm instances
  //
  // Vercel serverless reality:
  //   • Each warm instance is a separate Node.js process with its own pool
  //   • Typical concurrency: 5-20 warm instances during traffic spikes
  //   • At maxPoolSize=5 → 20 instances × 5 = 100 connections (safe)
  //   • Old maxPoolSize=20 → 20 instances × 20 = 400 connections (too close to M0 limit)
  //
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

  mongoose.set('strictQuery', true);

  console.log('[DB] Initiating MongoDB connection…');

  await mongoose.connect(uri, {
    // Pool sizing — CONSERVATIVE for M0 serverless
    maxPoolSize: 5,          // was 20 — absolute max connections per instance
    minPoolSize: 1,          // was 5  — keep only 1 idle connection; don't hold open extra sockets
    maxIdleTimeMS: 10_000,   // was absent — release a connection back to the pool after 10 s idle

    // Timeouts
    serverSelectionTimeoutMS: 10_000, // was 5_000 — give Atlas a bit more room to respond
    socketTimeoutMS: 45_000,          // unchanged — 45 s socket operation timeout
    connectTimeoutMS: 10_000,         // new — explicit connection establishment timeout

    // Index management
    // Never rebuild indexes automatically on every serverless connect in production
    autoIndex: !isProduction,

    // Fail fast: don't buffer Mongoose commands while disconnected.
    // A buffered command would silently queue up, then fire on reconnect —
    // which on serverless can mean commands executing against a stale connection.
    bufferCommands: false,
  });

  // ── Post-connect housekeeping ─────────────────────────────────────────────
  console.log('[DB] MongoDB connection established successfully.');

  // Detect replica-set topology so withTransaction() knows whether ACID
  // multi-document sessions are available on this connection.
  try {
    const admin = mongoose.connection.db?.admin();
    const hello = await admin?.command({ hello: 1 });
    isReplicaSet = Boolean(hello?.setName);
    console.log(
      `[DB] Topology: ${isReplicaSet
        ? 'Replica Set — ACID transactions available'
        : 'Standalone / Atlas Shared — no multi-document transactions'
      }`
    );
  } catch {
    isReplicaSet = false;
    console.warn('[DB] Could not determine topology; assuming no transactions.');
  }

  // ── Mongoose connection-event listeners ───────────────────────────────────
  // Register only once to avoid stacking duplicate listeners on re-use.
  if (mongoose.connection.listenerCount('error') === 0) {
    mongoose.connection.on('error', (err) => {
      console.error('[DB] Connection error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] Mongoose disconnected from MongoDB.');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[DB] Mongoose reconnected to MongoDB.');
    });
  }

  return mongoose;
}
