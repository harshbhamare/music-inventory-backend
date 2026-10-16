import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { ENV } from './config/env.js';
import { initializeScheduledJobs } from './jobs/cronJobs.js';
import { User } from './models/User.js';
import { seedDatabase } from './scripts/seed.js';

async function bootstrap() {
  try {
    console.log('[SERVER] Connecting to MongoDB...');
    await connectDB();

    // Auto-seed if database is empty
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      console.log('[SERVER] Empty database detected. Running initial seed...');
      await seedDatabase();
    }

    // Start background cron jobs
    initializeScheduledJobs();

    const app = createApp();
    const port = ENV.PORT;

    app.listen(port, () => {
      console.log(`[SERVER] 🎸 SoundStock Inventory API listening on port ${port} (${ENV.NODE_ENV})`);
      console.log(`[SERVER] Health check available at: http://localhost:${port}/api/health`);
    });
  } catch (err) {
    console.error('[SERVER_FATAL] Error starting SoundStock backend:', err);
    process.exit(1);
  }
}

bootstrap();
