import { connectDB, disconnectDB } from '../config/db.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
async function cleanDefaultEmails() {
    await connectDB();
    console.log('[CLEAN_EMAILS] Scanning EmailReportConfig for default / dummy emails...');
    const configs = await EmailReportConfig.find();
    for (const config of configs) {
        const original = config.recipients || [];
        // Remove default stereobliss / example dummy emails
        const filtered = original.filter((email) => {
            const lower = email.toLowerCase().trim();
            return (!lower.includes('@stereobliss.com') &&
                !lower.includes('@example.com') &&
                !lower.includes('stereobliss'));
        });
        console.log(`[CONFIG] ${config.reportType}: [${original.join(', ')}] -> [${filtered.join(', ')}]`);
        config.recipients = filtered;
        await config.save();
    }
    console.log('[CLEAN_EMAILS] Successfully cleaned default emails from all report configs.');
    await disconnectDB();
}
cleanDefaultEmails().catch(console.error);
