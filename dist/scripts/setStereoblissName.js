import { connectDB, disconnectDB } from '../config/db.js';
import { AppSetting } from '../models/AppSetting.js';
import { StockLocation } from '../models/StockLocation.js';
import { Product } from '../models/Product.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
const defaultTitles = {
    DAILY_STOCK_SUMMARY: 'Daily Stock Summary Report',
    WEEKLY_SALES_SUMMARY: 'Weekly Sales & Inward Summary',
    OVERDUE_USAGE_REMINDER: 'Overdue Rental Instruments Reminder',
    LOW_STOCK_ALERT: 'Critical Low Stock Alert',
};
async function updateName() {
    await connectDB();
    // 1. AppSetting
    const setting = await AppSetting.findOne();
    if (setting) {
        setting.companyName = 'Stereobliss Retail';
        setting.storeName = 'Stereobliss Central Store';
        setting.contactEmail = 'contact@stereobliss.com';
        setting.address = 'Stereobliss Central Store, Pune, Maharashtra, India';
        await setting.save();
        console.log('[SUCCESS] Updated companyName to "Stereobliss Retail" in AppSetting.');
    }
    // 2. Default StockLocation
    const defaultLoc = await StockLocation.findOne({ isDefault: true });
    if (defaultLoc) {
        defaultLoc.name = 'Stereobliss Central Store';
        defaultLoc.address = 'Stereobliss Central Store, Pune, Maharashtra, India';
        await defaultLoc.save();
        console.log('[SUCCESS] Updated default StockLocation to "Stereobliss Central Store".');
    }
    // 3. Products with Muziclub brand
    const prodRes = await Product.updateMany({ brand: { $in: ['Muziclub', 'muziclub', 'SoundStock', 'soundstock'] } }, { $set: { brand: 'Stereobliss' } });
    console.log(`[SUCCESS] Updated ${prodRes.modifiedCount} products to brand "Stereobliss".`);
    // 4. ReportConfigs email recipients
    const reports = await EmailReportConfig.find();
    for (const rep of reports) {
        if (!rep.title) {
            rep.title = defaultTitles[rep.reportType] || `${rep.reportType} Report`;
        }
        const updatedRecipients = rep.recipients.map((email) => email.replace(/@muziclub\.com/gi, '@stereobliss.com').replace(/@soundstock\.com/gi, '@stereobliss.com'));
        rep.recipients = updatedRecipients;
        await rep.save();
    }
    console.log(`[SUCCESS] Updated ${reports.length} report configs with titles and @stereobliss.com recipients.`);
    await disconnectDB();
    console.log('[COMPLETE] All database records successfully unified to Stereobliss!');
    process.exit(0);
}
updateName().catch((err) => {
    console.error('[ERROR]', err);
    process.exit(1);
});
