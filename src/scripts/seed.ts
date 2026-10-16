import mongoose from 'mongoose';
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
import {
  ROLES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  ITEM_CONDITIONS,
  MOVEMENT_TYPES,
  USAGE_PURPOSES,
  USAGE_STATUSES,
  REPORT_TYPES,
} from '../config/constants.js';

export async function seedDatabase() {
  console.log('[SEED] Starting SoundStock seed script...');
  await connectDB();

  // 1. Clear existing collections for a clean idempotent start
  await Promise.all([
    User.deleteMany({}),
    StockLocation.deleteMany({}),
    Category.deleteMany({}),
    Supplier.deleteMany({}),
    Product.deleteMany({}),
    SerializedItem.deleteMany({}),
    StockMovement.deleteMany({}),
    InternalUsage.deleteMany({}),
    AppSetting.deleteMany({}),
    EmailReportConfig.deleteMany({}),
    Purchase.deleteMany({}),
    PurchaseReceipt.deleteMany({}),
    Sale.deleteMany({}),
    CustomerReturn.deleteMany({}),
    UsageReturn.deleteMany({}),
    InventoryAdjustment.deleteMany({}),
    MaintenanceRecord.deleteMany({}),
    AuditLog.deleteMany({}),
    EmailDeliveryLog.deleteMany({}),
  ]);

  console.log('[SEED] Cleaned prior records across all collections.');

  // 2. Default Stock Location
  const defaultLocation = await StockLocation.create({
    name: 'Central Studio Academy & Retail Store',
    code: 'PUNE_HQ',
    type: 'STORE',
    address: 'Survey 128, Aundh-Ravet Road, Pune, Maharashtra 411007',
    isDefault: true,
    isActive: true,
  });

  console.log(`[SEED] Created default location: ${defaultLocation.name}`);

  // 3. Initial Users with all roles
  const passwordHash = await bcrypt.hash('Stock@2026', 10);

  const admin = await User.create({
    name: 'Harsh Vardhan (Super Admin)',
    email: 'admin@soundstock.io',
    passwordHash,
    role: ROLES.SUPER_ADMIN,
    isActive: true,
  });

  const manager = await User.create({
    name: 'Priya Sharma (Inventory Manager)',
    email: 'manager@soundstock.io',
    passwordHash,
    role: ROLES.INVENTORY_MANAGER,
    isActive: true,
  });

  const sales = await User.create({
    name: 'Rohan Patil (Sales Executive)',
    email: 'sales@soundstock.io',
    passwordHash,
    role: ROLES.SALES_STAFF,
    isActive: true,
  });

  const staff = await User.create({
    name: 'Anjali Deshmukh (Academy Staff)',
    email: 'staff@soundstock.io',
    passwordHash,
    role: ROLES.INVENTORY_STAFF,
    isActive: true,
  });

  const viewer = await User.create({
    name: 'Executive Management (Viewer)',
    email: 'viewer@soundstock.io',
    passwordHash,
    role: ROLES.VIEWER,
    isActive: true,
  });

  console.log('[SEED] Created 5 initial role users.');

  // 4. Categories
  const catGuitars = await Category.create({
    name: 'Guitars & Basses',
    description: 'Acoustic guitars, electric guitars, classical and bass guitars',
    isActive: true,
  });

  const catKeyboards = await Category.create({
    name: 'Keyboards & Pianos',
    description: 'Digital pianos, synthesizers, MIDI keyboards',
    isActive: true,
  });

  const catDrums = await Category.create({
    name: 'Drums & Percussion',
    description: 'Acoustic drum kits, electronic drums, cymbals, cajons',
    isActive: true,
  });

  const catAudio = await Category.create({
    name: 'Pro Audio & Microphones',
    description: 'Vocal microphones, studio monitors, audio interfaces, amplifiers',
    isActive: true,
  });

  const catAccessories = await Category.create({
    name: 'Accessories & Consumables',
    description: 'Strings, picks, cables, drumsticks, straps, stands',
    isActive: true,
  });

  // 5. Suppliers
  const supYamaha = await Supplier.create({
    name: 'Yamaha Music India Pvt Ltd',
    contactPerson: 'Vikram Joshi',
    email: 'sales.india@yamaha-music.com',
    phone: '+91 20 6712 3400',
    address: 'DLF Cyber City, Phase II, Gurugram, India',
    isActive: true,
  });

  const supFurtados = await Supplier.create({
    name: 'Furtados Music Distribution',
    contactPerson: 'David Vaz',
    email: 'orders@furtados.com',
    phone: '+91 22 4287 5000',
    address: 'Kalina, Santacruz East, Mumbai, India',
    isActive: true,
  });

  const supDaddario = await Supplier.create({
    name: 'D\'Addario India Accessories',
    contactPerson: 'Ramesh Kulkarni',
    email: 'india@daddario.com',
    phone: '+91 80 4123 9876',
    address: 'Indiranagar, Bangalore, India',
    isActive: true,
  });

  // 6. Products: Quantity-based accessories
  const prodStrings = await Product.create({
    name: 'D\'Addario EJ16 Phosphor Bronze Light Acoustic Strings',
    sku: 'DAD-EJ16-AC',
    category: catAccessories._id,
    brand: 'D\'Addario',
    modelName: 'EJ16-3D',
    description: 'Warm, bright, and balanced acoustic guitar tone with corrosion resistance.',
    trackingMode: TRACKING_MODES.QUANTITY,
    unitOfMeasure: 'pack',
    purchaseCost: 450,
    defaultSellingPrice: 750,
    supplier: supDaddario._id,
    minStockThreshold: 10,
    stockQuantity: {
      onHand: 50,
      reserved: 0,
      issuedInternal: 5,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 50,
        reserved: 0,
        issuedInternal: 5,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  const prodPicks = await Product.create({
    name: 'Dunlop Tortex Standard 0.73mm Yellow Picks (Pack of 12)',
    sku: 'DUN-PICK-073',
    category: catAccessories._id,
    brand: 'Dunlop',
    modelName: 'Tortex Standard 0.73',
    description: 'Maximum memory and minimum wear. The world standard for guitar picks.',
    trackingMode: TRACKING_MODES.QUANTITY,
    unitOfMeasure: 'pack',
    purchaseCost: 280,
    defaultSellingPrice: 480,
    supplier: supFurtados._id,
    minStockThreshold: 8,
    stockQuantity: {
      onHand: 35,
      reserved: 0,
      issuedInternal: 2,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 35,
        reserved: 0,
        issuedInternal: 2,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  const prodSticks = await Product.create({
    name: 'Vic Firth American Classic 5A Drumsticks (Wood Tip)',
    sku: 'VIC-5A-WOOD',
    category: catAccessories._id,
    brand: 'Vic Firth',
    modelName: '5A Hickory',
    description: 'Select hickory drumsticks for great response and feel in classes and practice.',
    trackingMode: TRACKING_MODES.QUANTITY,
    unitOfMeasure: 'pair',
    purchaseCost: 650,
    defaultSellingPrice: 1100,
    supplier: supFurtados._id,
    minStockThreshold: 5,
    stockQuantity: {
      onHand: 20,
      reserved: 0,
      issuedInternal: 4,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 20,
        reserved: 0,
        issuedInternal: 4,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  // 7. Products: Serialized instruments
  const prodAcoustic = await Product.create({
    name: 'Yamaha F310 Acoustic Folk Guitar Natural',
    sku: 'YAM-F310-NAT',
    category: catGuitars._id,
    brand: 'Yamaha',
    modelName: 'F310 NT',
    description: 'Dreadnought acoustic guitar offering outstanding quality and tone at an accessible price.',
    trackingMode: TRACKING_MODES.SERIALIZED,
    unitOfMeasure: 'unit',
    purchaseCost: 7200,
    defaultSellingPrice: 10490,
    supplier: supYamaha._id,
    minStockThreshold: 3,
    stockQuantity: {
      onHand: 4,
      reserved: 0,
      issuedInternal: 1,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 4,
        reserved: 0,
        issuedInternal: 1,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  const prodElectric = await Product.create({
    name: 'Fender Squier Bullet Stratocaster HSS Brown Sunburst',
    sku: 'FND-STRAT-HSS',
    category: catGuitars._id,
    brand: 'Fender Squier',
    modelName: 'Bullet Strat HSS',
    description: 'Classic Strat styling with humbucking bridge pickup for rock and jazz versatility.',
    trackingMode: TRACKING_MODES.SERIALIZED,
    unitOfMeasure: 'unit',
    purchaseCost: 11500,
    defaultSellingPrice: 16999,
    supplier: supFurtados._id,
    minStockThreshold: 2,
    stockQuantity: {
      onHand: 3,
      reserved: 0,
      issuedInternal: 0,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 3,
        reserved: 0,
        issuedInternal: 0,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  const prodPiano = await Product.create({
    name: 'Yamaha P-45 88-Key Weighted Graded Hammer Digital Piano',
    sku: 'YAM-P45-BLK',
    category: catKeyboards._id,
    brand: 'Yamaha',
    modelName: 'P-45B',
    description: 'Compact portable digital piano with authentic acoustic grand piano touch.',
    trackingMode: TRACKING_MODES.SERIALIZED,
    unitOfMeasure: 'unit',
    purchaseCost: 29000,
    defaultSellingPrice: 41500,
    supplier: supYamaha._id,
    minStockThreshold: 2,
    stockQuantity: {
      onHand: 3,
      reserved: 0,
      issuedInternal: 1,
      quarantined: 0,
    },
    locationStock: [
      {
        location: defaultLocation._id,
        onHand: 3,
        reserved: 0,
        issuedInternal: 1,
        quarantined: 0,
      },
    ],
    isActive: true,
  });

  // 8. Create Serialized Item Units for Yamaha F310
  const f310_1 = await SerializedItem.create({
    assetId: 'MZI-YAM-00101',
    manufacturerSerial: 'YAM-2026-F310-0981',
    product: prodAcoustic._id,
    unitCost: 7200,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.AVAILABLE,
    condition: ITEM_CONDITIONS.NEW,
    warrantyExpiry: new Date('2027-12-31'),
    notes: 'Floor display in main showroom',
  });

  const f310_2 = await SerializedItem.create({
    assetId: 'MZI-YAM-00102',
    manufacturerSerial: 'YAM-2026-F310-0982',
    product: prodAcoustic._id,
    unitCost: 7200,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.AVAILABLE,
    condition: ITEM_CONDITIONS.NEW,
    warrantyExpiry: new Date('2027-12-31'),
    notes: 'Boxed inventory in storeroom',
  });

  const f310_3 = await SerializedItem.create({
    assetId: 'MZI-YAM-00103',
    manufacturerSerial: 'YAM-2026-F310-0983',
    product: prodAcoustic._id,
    unitCost: 7200,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.AVAILABLE,
    condition: ITEM_CONDITIONS.MINT,
    warrantyExpiry: new Date('2027-12-31'),
    notes: 'Tuned and set up with low action',
  });

  // Unit 4: Issued for internal use in guitar batch
  const f310_4 = await SerializedItem.create({
    assetId: 'MZI-YAM-00104',
    manufacturerSerial: 'YAM-2026-F310-0984',
    product: prodAcoustic._id,
    unitCost: 7200,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.ISSUED_INTERNAL,
    condition: ITEM_CONDITIONS.GOOD,
    assignedTo: 'Aarav Mehta (Student - Batch A)',
    warrantyExpiry: new Date('2027-12-31'),
    notes: 'Issued for Academy Practice Studio 2',
  });

  // Serialized units for Fender Strat
  await SerializedItem.create([
    {
      assetId: 'MZI-FND-00201',
      manufacturerSerial: 'CY25091244',
      product: prodElectric._id,
      unitCost: 11500,
      location: defaultLocation._id,
      status: SERIALIZED_STATUSES.AVAILABLE,
      condition: ITEM_CONDITIONS.NEW,
      warrantyExpiry: new Date('2028-06-30'),
    },
    {
      assetId: 'MZI-FND-00202',
      manufacturerSerial: 'CY25091245',
      product: prodElectric._id,
      unitCost: 11500,
      location: defaultLocation._id,
      status: SERIALIZED_STATUSES.AVAILABLE,
      condition: ITEM_CONDITIONS.NEW,
      warrantyExpiry: new Date('2028-06-30'),
    },
    {
      assetId: 'MZI-FND-00203',
      manufacturerSerial: 'CY25091246',
      product: prodElectric._id,
      unitCost: 11500,
      location: defaultLocation._id,
      status: SERIALIZED_STATUSES.AVAILABLE,
      condition: ITEM_CONDITIONS.GOOD,
      warrantyExpiry: new Date('2028-06-30'),
    },
  ]);

  // Serialized units for Yamaha P-45
  const p45_1 = await SerializedItem.create({
    assetId: 'MZI-YAM-00301',
    manufacturerSerial: 'P45-89104-IN',
    product: prodPiano._id,
    unitCost: 29000,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.AVAILABLE,
    condition: ITEM_CONDITIONS.NEW,
    warrantyExpiry: new Date('2028-03-31'),
  });

  const p45_2 = await SerializedItem.create({
    assetId: 'MZI-YAM-00302',
    manufacturerSerial: 'P45-89105-IN',
    product: prodPiano._id,
    unitCost: 29000,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.AVAILABLE,
    condition: ITEM_CONDITIONS.NEW,
    warrantyExpiry: new Date('2028-03-31'),
  });

  const p45_3 = await SerializedItem.create({
    assetId: 'MZI-YAM-00303',
    manufacturerSerial: 'P45-89106-IN',
    product: prodPiano._id,
    unitCost: 29000,
    location: defaultLocation._id,
    status: SERIALIZED_STATUSES.ISSUED_INTERNAL,
    condition: ITEM_CONDITIONS.MINT,
    assignedTo: 'Piano Studio 1 (Teacher: Sameer Sen)',
    warrantyExpiry: new Date('2028-03-31'),
    notes: 'Assigned for daily classical piano classes',
  });

  // 9. Initial Stock Movement Ledger Records
  await StockMovement.create([
    {
      product: prodStrings._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 50,
      transactionRef: 'INIT-INTAKE-001',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial stock intake from D\'Addario India',
      performedBy: admin._id,
      idempotencyKey: 'init-strings-50',
    },
    {
      product: prodPicks._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 35,
      transactionRef: 'INIT-INTAKE-001',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial stock intake from Furtados',
      performedBy: admin._id,
      idempotencyKey: 'init-picks-35',
    },
    {
      product: prodSticks._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 20,
      transactionRef: 'INIT-INTAKE-001',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial stock intake from Furtados',
      performedBy: admin._id,
      idempotencyKey: 'init-sticks-20',
    },
    {
      product: prodAcoustic._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 4,
      transactionRef: 'INIT-INTAKE-002',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial intake of 4x Yamaha F310 guitars',
      performedBy: manager._id,
      idempotencyKey: 'init-acoustic-4',
    },
    {
      product: prodElectric._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 3,
      transactionRef: 'INIT-INTAKE-002',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial intake of 3x Fender Bullet Strats',
      performedBy: manager._id,
      idempotencyKey: 'init-electric-3',
    },
    {
      product: prodPiano._id,
      location: defaultLocation._id,
      movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
      quantityDelta: 3,
      transactionRef: 'INIT-INTAKE-002',
      transactionModel: 'PurchaseReceipt',
      reason: 'Initial intake of 3x Yamaha P-45 Pianos',
      performedBy: manager._id,
      idempotencyKey: 'init-piano-3',
    },
  ]);

  // 10. Sample Internal Loan: F310 issued for Academy Class
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);

  const sampleUsage = await InternalUsage.create({
    issueReference: 'USE-2026-00001',
    purpose: USAGE_PURPOSES.CLASS,
    assignedPerson: 'Aarav Mehta',
    assignedPersonContact: '+91 98234 11223',
    location: defaultLocation._id,
    items: [
      {
        product: prodAcoustic._id,
        quantityIssued: 1,
        quantityReturned: 0,
        serializedItemId: f310_4._id,
        issueCondition: ITEM_CONDITIONS.GOOD,
      },
    ],
    issueDate: new Date(),
    expectedReturnDate: nextWeek,
    status: USAGE_STATUSES.ACTIVE,
    notes: 'Issued for Beginner Acoustic Guitar Batch (Evenings)',
    issuedBy: staff._id,
  });

  f310_4.currentUsage = sampleUsage._id;
  await f310_4.save();

  // 11. Initial AppSetting
  await AppSetting.create({
    companyName: 'SoundStock Studio Academy & Store',
    contactEmail: 'inventory@soundstock.io',
    contactPhone: '+91 98765 43210',
    address: 'Survey 128, Aundh, Pune, Maharashtra 411007, India',
    currency: 'INR',
    currencySymbol: '₹',
    timeZone: 'Asia/Kolkata',
    defaultLocation: defaultLocation._id,
    managerApprovalThresholdValue: 3,
    overdueGracePeriodDays: 1,
    lowStockAlertThresholdDefault: 5,
  });

  // 12. Initial Email Report Configurations
  await EmailReportConfig.create([
    {
      reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
      title: 'Daily Stock & Availability Summary',
      recipients: ['inventory@soundstock.io', 'admin@soundstock.io'],
      scheduleCron: '0 9 * * *',
      timeZone: 'Asia/Kolkata',
      isEnabled: true,
    },
    {
      reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
      title: 'Weekly Sales Performance Summary',
      recipients: ['accounts@soundstock.io', 'admin@soundstock.io'],
      scheduleCron: '0 18 * * 0',
      timeZone: 'Asia/Kolkata',
      isEnabled: true,
    },
    {
      reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
      title: 'Daily Overdue Instrument Loans Notice',
      recipients: ['academy@soundstock.io', 'manager@soundstock.io'],
      scheduleCron: '0 10 * * *',
      timeZone: 'Asia/Kolkata',
      isEnabled: true,
    },
  ]);

  console.log('[SEED] Database seeded successfully with realistic data!');
}

let seedPromise: Promise<void> | null = null;

export async function ensureDatabaseSeeded(): Promise<boolean> {
  const userCount = await User.countDocuments();
  if (userCount > 0) {
    return false;
  }

  if (!seedPromise) {
    seedPromise = (async () => {
      try {
        console.log('[SEED] Database is empty (0 users). Auto-initializing with default roles and data...');
        await seedDatabase();
      } finally {
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

