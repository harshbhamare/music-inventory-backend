import { connectDB, disconnectDB } from '../config/db.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { REPORT_TYPES } from '../config/constants.js';

async function initConfigs() {
  await connectDB();
  const configs = [
    {
      reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
      scheduleCron: '0 20 * * *',
      timeZone: 'Asia/Kolkata',
      recipients: [],
      isEnabled: true,
      lastRunStatus: 'NEVER_RUN',
    },
    {
      reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
      scheduleCron: '0 9 * * 1',
      timeZone: 'Asia/Kolkata',
      recipients: [],
      isEnabled: true,
      lastRunStatus: 'NEVER_RUN',
    },
    {
      reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
      scheduleCron: '0 10 * * *',
      timeZone: 'Asia/Kolkata',
      recipients: [],
      isEnabled: true,
      lastRunStatus: 'NEVER_RUN',
    },
    {
      reportType: REPORT_TYPES.LOW_STOCK_ALERT,
      scheduleCron: '0 8 * * *',
      timeZone: 'Asia/Kolkata',
      recipients: [],
      isEnabled: true,
      lastRunStatus: 'NEVER_RUN',
    },
  ];

  for (const c of configs) {
    await EmailReportConfig.findOneAndUpdate(
      { reportType: c.reportType },
      { $set: c },
      { upsert: true, new: true }
    );
  }

  const count = await EmailReportConfig.countDocuments();
  console.log('[CONFIG] Successfully initialized scheduled report configs count:', count);
  await disconnectDB();
}

initConfigs().catch(console.error);
