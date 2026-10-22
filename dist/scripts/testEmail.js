import mongoose from 'mongoose';
import { ENV } from '../config/env.js';
import { dispatchReportEmail } from '../services/emailService.js';
async function main() {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(ENV.MONGODB_URI);
    const target = process.argv[2] || ENV.ALERT_EMAIL || ENV.SMTP_USER;
    console.log(`Dispatching test daily stock summary to ${target}...`);
    const log = await dispatchReportEmail('DAILY_STOCK_SUMMARY', target);
    console.log('SUCCESS! Report Log:', {
        status: log?.status,
        id: log?.providerReference,
        to: log?.recipients,
        subject: log?.subject,
        error: log?.errorDetails,
    });
    await mongoose.disconnect();
}
main().catch(console.error);
