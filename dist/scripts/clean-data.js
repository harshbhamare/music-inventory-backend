import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from '../config/db.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockMovement } from '../models/StockMovement.js';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Sale } from '../models/Sale.js';
import { CustomerReturn } from '../models/CustomerReturn.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { UsageReturn } from '../models/UsageReturn.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { AuditLog } from '../models/AuditLog.js';
import { Supplier } from '../models/Supplier.js';
import { Category } from '../models/Category.js';
import { StockLocation } from '../models/StockLocation.js';
import { User } from '../models/User.js';
import { AppSetting } from '../models/AppSetting.js';
import { ROLES } from '../config/constants.js';
export async function clearAllLocalData() {
    console.log('[CLEAN] Wiping all dummy catalog, inventory, and transaction data...');
    // Wipe inventory, transactions, and suppliers
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
        AuditLog.deleteMany({}),
        Supplier.deleteMany({}),
    ]);
    console.log('[CLEAN] Cleared products, serialized items, movements, transactions, and suppliers.');
    // Ensure standard categories exist (clean initial hierarchy)
    const categoryCount = await Category.countDocuments();
    if (categoryCount === 0) {
        const defaultCategories = [
            { name: 'Guitars & Basses', code: 'GUITARS', description: 'Acoustic, electric, and bass guitars' },
            { name: 'Keyboards & Pianos', code: 'KEYBOARDS', description: 'Digital pianos, synthesizers, and MIDI controllers' },
            { name: 'Drums & Percussion', code: 'DRUMS', description: 'Acoustic kits, electronic drum pads, and cymbals' },
            { name: 'Pro Audio & Microphones', code: 'AUDIO', description: 'Microphones, studio monitors, audio interfaces, and mixers' },
            { name: 'Cables & Accessories', code: 'ACCESSORIES', description: 'Instrument cables, stands, strings, straps, and tuners' },
        ];
        await Category.insertMany(defaultCategories);
        console.log('[CLEAN] Initialized base categories.');
    }
    // Ensure default stock location exists
    let defaultLoc = await StockLocation.findOne({ isDefault: true });
    if (!defaultLoc) {
        defaultLoc = await StockLocation.create({
            name: 'Stereobliss Central Store',
            code: 'CENTRAL',
            address: 'Stereobliss Central Store, Pune, Maharashtra',
            isDefault: true,
            isActive: true,
        });
        console.log('[CLEAN] Created default stock location: CENTRAL');
    }
    // Ensure default AppSetting exists
    let setting = await AppSetting.findOne();
    if (!setting) {
        await AppSetting.create({
            companyName: 'Stereobliss Retail',
            storeName: 'Stereobliss Central Store',
            storeCode: 'CENTRAL',
            contactEmail: 'contact@stereobliss.com',
            contactPhone: '+91 98765 43210',
            address: 'Stereobliss Central Store, Pune, Maharashtra, India',
            currencySymbol: '₹',
            defaultLocation: defaultLoc._id,
            managerApprovalThresholdValue: 3,
            timeZone: 'Asia/Kolkata',
        });
        console.log('[CLEAN] Created base AppSettings.');
    }
    // Ensure essential users exist for login (Two profile roles)
    const userCount = await User.countDocuments();
    if (userCount === 0) {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash('Stock@2026', salt);
        await User.insertMany([
            { name: 'System Administrator', email: 'admin@stereobliss.com', passwordHash, role: ROLES.SUPER_ADMIN, isActive: true },
            { name: 'Store Manager', email: 'manager@stereobliss.com', passwordHash, role: ROLES.MANAGER, isActive: true },
        ]);
        console.log('[CLEAN] Created 2 essential login accounts (password: Stock@2026): Super Admin and Manager.');
    }
    console.log('[CLEAN] Database is completely clean and ready for real inventory entry!');
}
async function run() {
    await connectDB();
    try {
        await clearAllLocalData();
    }
    catch (err) {
        console.error('[CLEAN] Error cleaning database:', err);
    }
    finally {
        await disconnectDB();
    }
}
// Execute if run directly
if (process.argv[1]?.endsWith('clean-data.ts') || process.argv[1]?.endsWith('clean-data.js')) {
    run();
}
