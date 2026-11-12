/**
 * api/index.ts — Vercel serverless entry point
 *
 * Vercel routes all requests to this single handler via vercel.json:
 *   { "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }
 *
 * Connection strategy:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  connectDB()          — idempotent; promise-locked in db.ts    │
 * │  ensureDatabaseSeeded — runs ONCE per warm instance, not per   │
 * │                         request (guarded by `dbReady` flag)    │
 * │  appInstance          — created ONCE per warm instance         │
 * │                         (guarded by `initPromise` to handle    │
 * │                         concurrent cold-start requests)        │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { createApp } from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { ensureDatabaseSeeded } from '../src/scripts/seed.js';
import type { Application } from 'express';

// ─── Module-level singletons (survive across warm invocations) ────────────────

/** Cached Express application — created once per warm serverless instance. */
let appInstance: Application | null = null;

/**
 * Tracks whether the one-time startup work (DB connect + seed check) has
 * already completed on this instance. Once true, every subsequent request
 * skips both operations entirely.
 */
let dbReady = false;

/**
 * Promise-lock for the initialisation phase: if two requests arrive
 * simultaneously on a cold start, only one runs the init work;
 * the other awaits the same Promise.
 */
let initPromise: Promise<void> | null = null;

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  // ── One-time initialisation (skipped on warm invocations) ───────────────
  if (!dbReady) {
    if (!initPromise) {
      initPromise = _initOnce().finally(() => {
        initPromise = null; // release lock after resolve/reject
      });
    }

    try {
      await initPromise;
    } catch (err: any) {
      console.error('[VERCEL] Initialisation failed:', err.message);

      // Only surface the error on health/root routes so we don't silently
      // swallow DB failures on API routes — they will naturally fail when
      // Mongoose operations time-out with bufferCommands:false.
      if (
        req.url === '/' ||
        req.url === '/health' ||
        req.url === '/api/health'
      ) {
        return res.status(500).json({
          status: 'error',
          message: err.message || 'Database initialisation failed.',
          hint: 'Ensure MONGODB_URI is set in Vercel → Settings → Environment Variables.',
        });
      }
      // For all other routes fall through — the route handler will return
      // its own error when the DB operation fails.
    }
  }

  // ── URL restoration after Vercel internal rewrite ────────────────────────
  // Vercel rewrites "/(.*)" → "/api" so req.url arrives as "/api".
  // The original path is preserved in x-matched-path / x-forwarded-uri.
  const matchedPath =
    req.headers['x-matched-path'] ||
    req.headers['x-vercel-matched-path'] ||
    req.headers['x-forwarded-uri'];

  if (matchedPath && (req.url === '/api' || req.url === '/api/index' || req.url === '/api/')) {
    req.url = matchedPath;
  }

  // ── Delegate to Express ──────────────────────────────────────────────────
  return appInstance!(req, res);
}

// ─── One-time initialisation logic ───────────────────────────────────────────

async function _initOnce(): Promise<void> {
  // 1. Establish (or reuse) the MongoDB connection.
  //    connectDB() is itself idempotent and promise-locked — safe to call here.
  await connectDB();

  // 2. Seed the database if it is brand-new (runs at most one DB query on
  //    subsequent warm requests because ensureDatabaseSeeded checks userCount
  //    and returns early). We call it here — once per instance lifetime —
  //    rather than on every request.
  await ensureDatabaseSeeded();

  // 3. Create the Express application once.
  if (!appInstance) {
    appInstance = createApp();
    console.log('[VERCEL] Express application initialised.');
  }

  dbReady = true;
  console.log('[VERCEL] Instance ready — subsequent requests will skip DB init.');
}
