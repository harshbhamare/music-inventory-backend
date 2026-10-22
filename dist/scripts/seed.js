import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { StockLocation } from '../models/StockLocation.js';
import { Category } from '../models/Category.js';
import { Supplier } from '../models/Supplier.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockMovement } from '../models/StockMovement.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { AppSetting } from '../models/AppSetting.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Sale } from '../models/Sale.js';
import { CustomerReturn } from '../models/CustomerReturn.js';
import { UsageReturn } from '../models/UsageReturn.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { AuditLog } from '../models/AuditLog.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { ROLES, REPORT_TYPES, } from '../config/constants.js';
export async function seedDatabase() {
    console.log('[SEED] Starting Stereobliss clean initialization script...');
    await connectDB();
    // 1. Wipe all previous dummy/mock data
    await Promise.all([
        Product.deleteMany({}),
        SerializedItem.deleteMany({}),
        StockMovement.deleteMany({}),
        Purchase.deleteMany({}),
        PurchaseReceipt.deleteMany({}),
        Sale.deleteMany({}),
        CustomerReturn.deleteMany({}),
        InternalUsage.deleteMany({}),
        UsageReturn.deleteMany({}),
        InventoryAdjustment.deleteMany({}),
        MaintenanceRecord.deleteMany({}),
        AuditLog.deleteMany({}),
        EmailDeliveryLog.deleteMany({}),
        Supplier.deleteMany({}),
    ]);
    console.log('[SEED] Purged all dummy products, inventory, transactions, and logs.');
    // 2. Default Stock Location
    let defaultLocation = await StockLocation.findOne({ isDefault: true });
    if (!defaultLocation) {
        defaultLocation = await StockLocation.create({
            name: 'Stereobliss Central Store',
            code: 'CENTRAL',
            type: 'STORE',
            address: 'Stereobliss Central Store, Pune, Maharashtra',
            isDefault: true,
            isActive: true,
        });
        console.log(`[SEED] Initialized default location: ${defaultLocation.name}`);
    }
    // 3. User Accounts (Only two profile roles: Super Admin & Manager)
    const passwordHash = await bcrypt.hash('Stock@2026', 10);
    const adminExists = await User.findOne({ email: 'admin@stereobliss.com' });
    if (!adminExists) {
        await User.create({
            name: 'Harsh Vardhan (Super Admin)',
            email: 'admin@stereobliss.com',
            passwordHash,
            role: ROLES.SUPER_ADMIN,
            isActive: true,
        });
        console.log('[SEED] Created Super Admin account: admin@stereobliss.com');
    }
    const managerExists = await User.findOne({ email: 'manager@stereobliss.com' });
    if (!managerExists) {
        await User.create({
            name: 'Priya Sharma (Manager)',
            email: 'manager@stereobliss.com',
            passwordHash,
            role: ROLES.MANAGER,
            isActive: true,
        });
        console.log('[SEED] Created Manager account: manager@stereobliss.com');
    }
    // 4. Base Categories
    const categoryCount = await Category.countDocuments();
    if (categoryCount === 0) {
        await Category.insertMany([
            { name: 'Guitars & Basses', code: 'GUITARS', description: 'Acoustic, electric, and bass guitars', isActive: true },
            { name: 'Keyboards & Pianos', code: 'KEYBOARDS', description: 'Digital pianos, synthesizers, and MIDI controllers', isActive: true },
            { name: 'Drums & Percussion', code: 'DRUMS', description: 'Acoustic kits, electronic drum pads, and cymbals', isActive: true },
            { name: 'Pro Audio & Microphones', code: 'AUDIO', description: 'Microphones, studio monitors, audio interfaces, and mixers', isActive: true },
            { name: 'Cables & Accessories', code: 'ACCESSORIES', description: 'Instrument cables, stands, strings, straps, and tuners', isActive: true },
        ]);
        console.log('[SEED] Initialized standard retail categories.');
    }
    // 5. System Settings
    let setting = await AppSetting.findOne();
    if (!setting) {
        await AppSetting.create({
            companyName: 'Stereobliss Retail',
            storeName: 'Stereobliss Central Store',
            storeCode: 'CENTRAL',
            contactEmail: '',
            contactPhone: '',
            address: '',
            gstin: '',
            stateName: 'Maharashtra',
            stateCode: '27',
            currencySymbol: '₹',
            defaultLocation: defaultLocation._id,
            managerApprovalThresholdValue: 3,
            timeZone: 'Asia/Kolkata',
        });
        console.log('[SEED] Configured default AppSetting.');
    }
    // 6. Base Email Report Config
    const reportConfigCount = await EmailReportConfig.countDocuments();
    if (reportConfigCount === 0) {
        await EmailReportConfig.create({
            reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
            recipients: [],
            scheduleCron: '0 20 * * *',
            timeZone: 'Asia/Kolkata',
            isEnabled: true,
        });
        console.log('[SEED] Configured default automated daily summary email schedule.');
    }
    console.log('[SEED] Clean initialization complete. ZERO dummy data present!');
}
let seedPromise = null;
export async function ensureDatabaseSeeded() {
    const userCount = await User.countDocuments();
    if (userCount > 0) {
        // Ensure both Stereobliss accounts exist with proper roles
        const adminExists = await User.findOne({ email: 'admin@stereobliss.com' });
        if (!adminExists) {
            const passwordHash = await bcrypt.hash('Stock@2026', 10);
            await User.create({
                name: 'Harsh Vardhan (Super Admin)',
                email: 'admin@stereobliss.com',
                passwordHash,
                role: ROLES.SUPER_ADMIN,
                isActive: true,
            });
        }
        const managerExists = await User.findOne({ email: 'manager@stereobliss.com' });
        if (!managerExists) {
            const passwordHash = await bcrypt.hash('Stock@2026', 10);
            await User.create({
                name: 'Priya Sharma (Manager)',
                email: 'manager@stereobliss.com',
                passwordHash,
                role: ROLES.MANAGER,
                isActive: true,
            });
        }
        return false;
    }
    if (!seedPromise) {
        seedPromise = (async () => {
            try {
                console.log('[SEED] Initializing clean database baseline...');
                await seedDatabase();
            }
            finally {
                seedPromise = null;
            }
        })();
    }
    await seedPromise;
    return true;
}
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
    seedDatabase()
        .then(async () => {
        await disconnectDB();
        process.exit(0);
    })
        .catch((err) => {
        console.error('[SEED_ERROR]', err);
        process.exit(1);
    });
}
