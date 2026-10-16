import { createApp } from '../src/app.js';
import { connectDB } from '../src/config/db.js';

let appInstance: any = null;

export default async function handler(req: any, res: any) {
  try {
    await connectDB();
  } catch (err: any) {
    console.error('[VERCEL_SERVERLESS] DB connection error:', err);
    if (req.url === '/' || req.url === '/health' || req.url === '/api/health') {
      return res.status(500).json({
        status: 'error',
        message: err.message || 'Database connection error',
        hint: 'Please ensure MONGODB_URI is properly configured in your Vercel project environment variables.'
      });
    }
  }

  // Restore original URL if Vercel internal rewrite routed to destination path
  const matchedPath = req.headers['x-vercel-matched-path'] || req.headers['x-matched-path'] || req.headers['x-forwarded-uri'];
  if (matchedPath && (req.url === '/api' || req.url === '/api/index')) {
    req.url = matchedPath;
  }

  if (!appInstance) {
    appInstance = createApp();
  }

  return appInstance(req, res);
}
