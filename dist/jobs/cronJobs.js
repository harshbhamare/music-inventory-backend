import cron from 'node-cron';
import { InternalUsage } from '../models/InternalUsage.js';
import { USAGE_STATUSES } from '../config/constants.js';
import { sendDailyStockSummary, sendOverdueUsageReminders } from '../services/emailService.js';
export function initializeScheduledJobs() {
    console.log('[CRON] Initializing automated background jobs...');
    // 1. Mark overdue usages every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        try {
            const now = new Date();
            const result = await InternalUsage.updateMany({
                status: USAGE_STATUSES.ACTIVE,
                expectedReturnDate: { $lt: now },
            }, {
                $set: { status: USAGE_STATUSES.OVERDUE },
            });
            if (result.modifiedCount > 0) {
                console.log(`[CRON] Flagged ${result.modifiedCount} internal usage loans as OVERDUE.`);
            }
        }
        catch (err) {
            console.error('[CRON_ERROR] Failed to update overdue usage records:', err);
        }
    });
    // 2. Daily Stock Summary email at 9:00 AM
    cron.schedule('0 9 * * *', async () => {
        try {
            console.log('[CRON] Running scheduled Daily Stock Summary dispatch...');
            await sendDailyStockSummary();
        }
        catch (err) {
            console.error('[CRON_ERROR] Failed daily stock summary dispatch:', err);
        }
    });
    // 3. Overdue instrument loan alerts at 10:00 AM
    cron.schedule('0 10 * * *', async () => {
        try {
            console.log('[CRON] Running scheduled Overdue Usage notification check...');
            await sendOverdueUsageReminders();
        }
        catch (err) {
            console.error('[CRON_ERROR] Failed overdue loan reminders dispatch:', err);
        }
    });
    console.log('[CRON] Background schedules active.');
}
