import { createApp } from '../src/app.js';
import { connectDB } from '../src/config/db.js';

let appInstance: any = null;

export default async function handler(req: any, res: any) {
  try {
    await connectDB();
  } catch (err) {
    console.error('[VERCEL_SERVERLESS] DB connection error:', err);
  }

  if (!appInstance) {
    appInstance = createApp();
  }

  return appInstance(req, res);
}
