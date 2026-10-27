import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { ENV } from './config/env.js';
import { initializeScheduledJobs } from './jobs/cronJobs.js';
import { ensureDatabaseSeeded } from './scripts/seed.js';
import { Product } from './models/Product.js';

async function bootstrap() {
  try {
    console.log('[SERVER] Connecting to MongoDB...');
    await connectDB();

    // Auto-seed if database is empty
    await ensureDatabaseSeeded();

    // Ensure all products are purely bulk quantity (serialized completely removed)
    await Product.updateMany({ trackingMode: { $ne: 'QUANTITY' } }, { $set: { trackingMode: 'QUANTITY' } });

    // Background cron jobs removed per requirement (manual report emailing enabled)
    // initializeScheduledJobs();

    const app = createApp();
    const port = ENV.PORT;

    app.listen(port, () => {
      console.log(`[SERVER] 🎧 Stereobliss Retail Inventory API listening on port ${port} (${ENV.NODE_ENV})`);
      console.log(`[SERVER] Health check available at: http://localhost:${port}/api/health`);
    });
  } catch (err) {
    console.error('[SERVER_FATAL] Error starting Stereobliss backend:', err);
    process.exit(1);
  }
}

bootstrap();
