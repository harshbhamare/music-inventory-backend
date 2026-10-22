import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { ENV } from './config/env.js';
import { ensureDatabaseSeeded } from './scripts/seed.js';
async function bootstrap() {
    try {
        console.log('[SERVER] Connecting to MongoDB...');
        await connectDB();
        // Auto-seed if database is empty
        await ensureDatabaseSeeded();
        // Background cron jobs removed per requirement (manual report emailing enabled)
        // initializeScheduledJobs();
        const app = createApp();
        const port = ENV.PORT;
        app.listen(port, () => {
            console.log(`[SERVER] 🎧 Stereobliss Retail Inventory API listening on port ${port} (${ENV.NODE_ENV})`);
            console.log(`[SERVER] Health check available at: http://localhost:${port}/api/health`);
        });
    }
    catch (err) {
        console.error('[SERVER_FATAL] Error starting Stereobliss backend:', err);
        process.exit(1);
    }
}
bootstrap();
