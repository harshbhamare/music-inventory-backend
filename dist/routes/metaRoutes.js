import { Router } from 'express';
import { Category } from '../models/Category.js';
import { Supplier } from '../models/Supplier.js';
import { StockLocation } from '../models/StockLocation.js';
import { AppSetting } from '../models/AppSetting.js';
import { AuditLog } from '../models/AuditLog.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { Product } from '../models/Product.js';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Sale } from '../models/Sale.js';
import { StockMovement } from '../models/StockMovement.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { User } from '../models/User.js';
import { clearAllLocalData } from '../scripts/clean-data.js';
import { ensureDatabaseSeeded } from '../scripts/seed.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES, REPORT_TYPES } from '../config/constants.js';
import { reloadScheduledJobs } from '../jobs/cronJobs.js';
import { sendDailyStockSummary, sendOverdueUsageReminders, sendWeeklySalesSummary, sendLowStockAlert, } from '../services/emailService.js';
import cron from 'node-cron';
const router = Router();
// Categories
router.get('/categories', requireAuth, async (_req, res, next) => {
    try {
        const categories = await Category.find({ isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: { categories } });
    }
    catch (err) {
        next(err);
    }
});
router.post('/categories', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const category = await Category.create(req.body);
        res.status(201).json({ success: true, data: { category } });
    }
    catch (err) {
        next(err);
    }
});
// Suppliers
router.get('/suppliers', requireAuth, async (_req, res, next) => {
    try {
        const suppliers = await Supplier.find({ isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: { suppliers } });
    }
    catch (err) {
        next(err);
    }
});
router.post('/suppliers', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const supplier = await Supplier.create(req.body);
        res.status(201).json({ success: true, data: { supplier } });
    }
    catch (err) {
        next(err);
    }
});
router.put('/suppliers/:id', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const supplier = await Supplier.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
        if (!supplier) {
            return res.status(404).json({ success: false, message: 'Supplier not found.' });
        }
        res.json({ success: true, data: { supplier } });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/suppliers/:id', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const supplier = await Supplier.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
        if (!supplier) {
            return res.status(404).json({ success: false, message: 'Supplier not found.' });
        }
        res.json({ success: true, message: 'Supplier removed successfully.' });
    }
    catch (err) {
        next(err);
    }
});
// Locations
router.get('/locations', requireAuth, async (_req, res, next) => {
    try {
        const locations = await StockLocation.find({ isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: { locations } });
    }
    catch (err) {
        next(err);
    }
});
router.post('/locations', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const location = await StockLocation.create(req.body);
        res.status(201).json({ success: true, data: { location } });
    }
    catch (err) {
        next(err);
    }
});
// Public Settings (accessible for branding in shell / login without auth)
router.get('/settings/public', async (_req, res, next) => {
    try {
        const setting = await AppSetting.findOne().populate('defaultLocation').lean();
        const defaultLoc = setting?.defaultLocation || (await StockLocation.findOne({ isDefault: true }).lean());
        res.json({
            success: true,
            data: {
                companyName: setting?.companyName || 'Muziclub Inventory',
                storeName: setting?.storeName || defaultLoc?.name || 'Muziclub Central Studio & Academy',
                storeCode: setting?.storeCode || defaultLoc?.code || 'CENTRAL',
                currencySymbol: setting?.currencySymbol || '₹',
                timeZone: setting?.timeZone || 'Asia/Kolkata',
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// Full Settings
router.get('/settings', requireAuth, async (_req, res, next) => {
    try {
        let setting = await AppSetting.findOne().populate('defaultLocation').lean();
        let defaultLoc = await StockLocation.findOne({ isDefault: true }) || await StockLocation.findOne();
        if (!defaultLoc) {
            defaultLoc = await StockLocation.create({
                name: 'Muziclub Central Studio & Academy',
                code: 'CENTRAL',
                type: 'STORE',
                address: 'Central Studio Campus, Floor 1, Pune, Maharashtra',
                isDefault: true,
                isActive: true,
            });
        }
        if (!setting) {
            setting = (await AppSetting.create({
                companyName: 'Muziclub Inventory',
                storeName: defaultLoc.name,
                storeCode: defaultLoc.code,
                contactEmail: 'contact@muziclub.com',
                contactPhone: '+91 98765 43210',
                address: defaultLoc.address || 'Aundh & Hinjawadi, Pune, Maharashtra, India',
                defaultLocation: defaultLoc._id,
            })).toObject();
        }
        else {
            // Ensure storeName and storeCode are populated from location if not set
            if (!setting.storeName && defaultLoc)
                setting.storeName = defaultLoc.name;
            if (!setting.storeCode && defaultLoc)
                setting.storeCode = defaultLoc.code;
        }
        const locations = await StockLocation.find({ isActive: true }).sort({ name: 1 }).lean();
        res.json({ success: true, data: { setting, locations, defaultLocation: defaultLoc } });
    }
    catch (err) {
        next(err);
    }
});
router.patch('/settings', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const { companyName, storeName, storeCode, contactEmail, contactPhone, address, currency, currencySymbol, managerApprovalThresholdValue, lowStockAlertThresholdDefault, timeZone, defaultLocationId, } = req.body;
        let setting = await AppSetting.findOne();
        if (!setting) {
            setting = new AppSetting();
        }
        // Update AppSetting fields
        if (companyName !== undefined)
            setting.companyName = companyName.trim();
        if (storeName !== undefined)
            setting.storeName = storeName.trim();
        if (storeCode !== undefined)
            setting.storeCode = storeCode.trim().toUpperCase();
        if (contactEmail !== undefined)
            setting.contactEmail = contactEmail.trim().toLowerCase();
        if (contactPhone !== undefined)
            setting.contactPhone = contactPhone.trim();
        if (address !== undefined)
            setting.address = address.trim();
        if (currency !== undefined)
            setting.currency = currency.trim().toUpperCase();
        if (currencySymbol !== undefined)
            setting.currencySymbol = currencySymbol.trim();
        if (managerApprovalThresholdValue !== undefined) {
            setting.managerApprovalThresholdValue = Number(managerApprovalThresholdValue) || 3;
        }
        if (lowStockAlertThresholdDefault !== undefined) {
            setting.lowStockAlertThresholdDefault = Number(lowStockAlertThresholdDefault) || 5;
        }
        if (timeZone !== undefined)
            setting.timeZone = timeZone;
        // Sync with StockLocation
        let defaultLoc = null;
        if (defaultLocationId) {
            defaultLoc = await StockLocation.findById(defaultLocationId);
        }
        else if (setting.defaultLocation) {
            defaultLoc = await StockLocation.findById(setting.defaultLocation);
        }
        else {
            defaultLoc = await StockLocation.findOne({ isDefault: true }) || await StockLocation.findOne();
        }
        if (!defaultLoc) {
            defaultLoc = await StockLocation.create({
                name: storeName?.trim() || 'Muziclub Central Studio & Academy',
                code: storeCode?.trim().toUpperCase() || 'CENTRAL',
                type: 'STORE',
                address: address?.trim() || 'Central Campus, Floor 1, Pune',
                isDefault: true,
                isActive: true,
            });
        }
        else {
            if (storeName)
                defaultLoc.name = storeName.trim();
            if (storeCode)
                defaultLoc.code = storeCode.trim().toUpperCase();
            if (address)
                defaultLoc.address = address.trim();
            await defaultLoc.save();
        }
        setting.defaultLocation = defaultLoc._id;
        await setting.save();
        const populatedSetting = await AppSetting.findById(setting._id).populate('defaultLocation').lean();
        res.json({
            success: true,
            message: 'Organization & Store Details successfully updated.',
            data: { setting: populatedSetting, defaultLocation: defaultLoc },
        });
    }
    catch (err) {
        next(err);
    }
});
// Email Report Configs
router.get('/report-configs', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (_req, res, next) => {
    try {
        const setting = await AppSetting.findOne().lean();
        const defaultEmail = setting?.contactEmail || 'inventory@muziclub.com';
        const existingConfigs = await EmailReportConfig.find().lean();
        const existingTypes = new Set(existingConfigs.map((c) => c.reportType));
        const standardConfigs = [
            {
                reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
                title: 'Daily Stock & Inventory Summary',
                recipients: [defaultEmail],
                scheduleCron: '0 9 * * *', // 9:00 AM daily
                timeZone: setting?.timeZone || 'Asia/Kolkata',
                isEnabled: true,
            },
            {
                reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
                title: 'Daily Overdue Instrument Loan Alerts',
                recipients: [defaultEmail],
                scheduleCron: '0 10 * * *', // 10:00 AM daily
                timeZone: setting?.timeZone || 'Asia/Kolkata',
                isEnabled: true,
            },
            {
                reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
                title: 'Weekly Sales Performance Summary',
                recipients: [defaultEmail],
                scheduleCron: '0 18 * * 0', // Sunday 6:00 PM
                timeZone: setting?.timeZone || 'Asia/Kolkata',
                isEnabled: true,
            },
            {
                reportType: REPORT_TYPES.LOW_STOCK_ALERT,
                title: 'Low Stock Safety Threshold Alert',
                recipients: [defaultEmail],
                scheduleCron: '0 8 * * *', // 8:00 AM daily
                timeZone: setting?.timeZone || 'Asia/Kolkata',
                isEnabled: true,
            },
        ];
        for (const sc of standardConfigs) {
            if (!existingTypes.has(sc.reportType)) {
                await EmailReportConfig.create(sc);
            }
        }
        const configs = await EmailReportConfig.find().sort({ createdAt: 1 }).lean();
        res.json({ success: true, data: { configs } });
    }
    catch (err) {
        next(err);
    }
});
router.patch('/report-configs/:id', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const { scheduleCron, recipients, isEnabled, title, timeZone } = req.body;
        const updates = {};
        if (title !== undefined)
            updates.title = title.trim();
        if (isEnabled !== undefined)
            updates.isEnabled = Boolean(isEnabled);
        if (timeZone !== undefined)
            updates.timeZone = timeZone;
        if (scheduleCron !== undefined) {
            const trimmedCron = scheduleCron.trim();
            if (!cron.validate(trimmedCron)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid cron expression: "${trimmedCron}". Standard 5-part format required (e.g. "0 9 * * *").`,
                });
            }
            updates.scheduleCron = trimmedCron;
        }
        if (recipients !== undefined) {
            if (Array.isArray(recipients)) {
                const cleaned = recipients
                    .map((r) => String(r).trim().toLowerCase())
                    .filter((r) => r.length > 0 && r.includes('@'));
                updates.recipients = cleaned;
            }
            else if (typeof recipients === 'string') {
                const cleaned = recipients
                    .split(/[,;\n]/)
                    .map((r) => r.trim().toLowerCase())
                    .filter((r) => r.length > 0 && r.includes('@'));
                updates.recipients = cleaned;
            }
        }
        const config = await EmailReportConfig.findByIdAndUpdate(req.params.id, updates, {
            new: true,
        });
        if (!config) {
            return res.status(404).json({ success: false, message: 'Report schedule config not found.' });
        }
        // Automatically reload node-cron background runners with the updated schedule & recipients!
        await reloadScheduledJobs();
        res.json({
            success: true,
            message: 'Automated schedule successfully updated and background runner reloaded.',
            data: { config },
        });
    }
    catch (err) {
        next(err);
    }
});
// Manually trigger a scheduled report immediately to configured recipients
router.post('/report-configs/:id/run-now', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res, next) => {
    try {
        const config = await EmailReportConfig.findById(req.params.id);
        if (!config) {
            return res.status(404).json({ success: false, message: 'Report schedule config not found.' });
        }
        if (!config.recipients || config.recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No recipient email addresses configured for this report.',
            });
        }
        console.log(`[MANUAL_TRIGGER] Triggering immediate execution of report ${config.reportType} by ${req.user.email}...`);
        let logResult = null;
        switch (config.reportType) {
            case REPORT_TYPES.DAILY_STOCK_SUMMARY:
                logResult = await sendDailyStockSummary(config.recipients);
                break;
            case REPORT_TYPES.OVERDUE_USAGE_REMINDER:
                logResult = await sendOverdueUsageReminders(config.recipients);
                break;
            case REPORT_TYPES.WEEKLY_SALES_SUMMARY:
                logResult = await sendWeeklySalesSummary(config.recipients);
                break;
            case REPORT_TYPES.LOW_STOCK_ALERT:
                logResult = await sendLowStockAlert(config.recipients);
                break;
            default:
                return res.status(400).json({ success: false, message: `Unsupported report type: ${config.reportType}` });
        }
        config.lastRunAt = new Date();
        await config.save();
        res.json({
            success: true,
            message: `Report "${config.title}" triggered successfully to ${config.recipients.length} recipient(s).`,
            data: { log: logResult, lastRunAt: config.lastRunAt },
        });
    }
    catch (err) {
        next(err);
    }
});
// Audit Logs
router.get('/audit-logs', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const skip = (page - 1) * limit;
        const query = {};
        if (req.query.action)
            query.action = req.query.action;
        if (req.query.entityType)
            query.entityType = req.query.entityType;
        const [logs, total] = await Promise.all([
            AuditLog.find(query)
                .populate('actor', 'name email role')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            AuditLog.countDocuments(query),
        ]);
        res.json({
            success: true,
            data: {
                logs,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// System Info
router.get('/system-info', async (_req, res, next) => {
    try {
        const [productsCount, serializedItemsCount, purchasesCount, receiptsCount, salesCount, movementsCount, usersCount,] = await Promise.all([
            Product.countDocuments({ isActive: true }),
            SerializedItem.countDocuments(),
            Purchase.countDocuments(),
            PurchaseReceipt.countDocuments(),
            Sale.countDocuments(),
            StockMovement.countDocuments(),
            User.countDocuments(),
        ]);
        res.json({
            success: true,
            data: {
                counts: {
                    products: productsCount,
                    serializedItems: serializedItemsCount,
                    purchases: purchasesCount,
                    receipts: receiptsCount,
                    sales: salesCount,
                    movements: movementsCount,
                    users: usersCount,
                },
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// Reset Temporary Data (Clean Database)
router.post('/reset-data', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (_req, res, next) => {
    try {
        console.log('[RESET] Initiating full system data cleanup...');
        await clearAllLocalData();
        res.json({
            success: true,
            message: 'All temporary data successfully wiped. System is clean and ready.',
        });
    }
    catch (err) {
        next(err);
    }
});
// Initial Database Seeding endpoint (Public if 0 users exist; Super Admin protected if populated)
router.all('/seed', async (req, res, next) => {
    try {
        const userCount = await User.countDocuments();
        if (userCount > 0) {
            return res.status(400).json({
                success: false,
                message: 'Database is already initialized and seeded with users. Seeding aborted.',
            });
        }
        console.log('[SEED] Triggering initial database seed via /api/v1/meta/seed...');
        await ensureDatabaseSeeded();
        res.json({
            success: true,
            message: 'Database seeded successfully with default accounts and demo inventory.',
        });
    }
    catch (err) {
        next(err);
    }
});
export default router;
