import cron from 'node-cron';
import { InternalUsage } from '../models/InternalUsage.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { USAGE_STATUSES, REPORT_TYPES } from '../config/constants.js';
import { sendDailyStockSummary, sendOverdueUsageReminders, sendWeeklySalesSummary, sendLowStockAlert, } from '../services/emailService.js';
// Map of active cron tasks by configId / task key
const scheduledTasks = new Map();
export async function reloadScheduledJobs() {
    console.log('[CRON] Reloading and synchronizing dynamic background cron schedules...');
    // 1. Stop all currently scheduled email report jobs
    for (const [key, task] of scheduledTasks.entries()) {
        if (key !== 'overdue_check') {
            task.stop();
            scheduledTasks.delete(key);
        }
    }
    // 2. Fetch all enabled report configs from database
    try {
        const configs = await EmailReportConfig.find({ isEnabled: true }).lean();
        console.log(`[CRON] Found ${configs.length} active email schedule configs to register.`);
        for (const config of configs) {
            const { _id, reportType, scheduleCron, recipients, title } = config;
            if (!scheduleCron || !cron.validate(scheduleCron)) {
                console.warn(`[CRON_WARN] Invalid cron expression "${scheduleCron}" for config "${title}" (${reportType}). Skipping.`);
                continue;
            }
            if (!recipients || recipients.length === 0) {
                console.warn(`[CRON_WARN] No recipients configured for "${title}". Skipping.`);
                continue;
            }
            const task = cron.schedule(scheduleCron, async () => {
                console.log(`[CRON_TRIGGER] Executing scheduled report "${title}" (${reportType}) to [${recipients.join(', ')}]...`);
                try {
                    switch (reportType) {
                        case REPORT_TYPES.DAILY_STOCK_SUMMARY:
                            await sendDailyStockSummary(recipients);
                            break;
                        case REPORT_TYPES.OVERDUE_USAGE_REMINDER:
                            await sendOverdueUsageReminders(recipients);
                            break;
                        case REPORT_TYPES.WEEKLY_SALES_SUMMARY:
                            await sendWeeklySalesSummary(recipients);
                            break;
                        case REPORT_TYPES.LOW_STOCK_ALERT:
                            await sendLowStockAlert(recipients);
                            break;
                        default:
                            console.log(`[CRON] Unknown reportType ${reportType}`);
                    }
                    // Update lastRunAt timestamp
                    await EmailReportConfig.findByIdAndUpdate(_id, { lastRunAt: new Date() });
                }
                catch (err) {
                    console.error(`[CRON_ERROR] Failed executing scheduled report ${reportType}:`, err);
                }
            }, {
                timezone: config.timeZone || 'Asia/Kolkata',
            });
            scheduledTasks.set(_id.toString(), task);
            console.log(`[CRON_REGISTERED] Scheduled "${title}" with cron: "${scheduleCron}" (${config.timeZone || 'Asia/Kolkata'})`);
        }
    }
    catch (err) {
        console.error('[CRON_ERROR] Failed to load email report configs from database:', err);
    }
}
export function initializeScheduledJobs() {
    console.log('[CRON] Initializing automated background jobs...');
    // 1. Maintain background check to mark overdue usages every 15 minutes
    if (!scheduledTasks.has('overdue_check')) {
        const overdueTask = cron.schedule('*/15 * * * *', async () => {
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
        scheduledTasks.set('overdue_check', overdueTask);
    }
    // 2. Load dynamic report configs
    reloadScheduledJobs().catch((err) => {
        console.error('[CRON_ERROR] Initial reload of scheduled jobs failed:', err);
    });
    console.log('[CRON] Background schedules active.');
}
