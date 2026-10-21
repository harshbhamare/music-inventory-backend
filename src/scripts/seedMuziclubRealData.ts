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
import { Sale } from '../models/Sale.js';
import {
  ROLES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  MOVEMENT_TYPES,
  USAGE_PURPOSES,
  USAGE_STATUSES,
  REPORT_TYPES,
} from '../config/constants.js';

export async function seedMuziclubRealData() {
  console.log('[STEREOBLISS_SEED] Populating authentic music store & pro audio inventory...');
  await connectDB();

  // 1. Ensure Stock Location
  let location = await StockLocation.findOne({ isDefault: true });
  if (!location) {
    location = await StockLocation.create({
      name: 'Stereobliss Central Store',
      code: 'CENTRAL',
      type: 'STORE',
      address: 'Stereobliss Central Store, Pune, Maharashtra',
      isDefault: true,
      isActive: true,
    });
  }

  // 2. Ensure Users (both stereobliss and muziclub domain for convenience)
  const passwordHash = await bcrypt.hash('Stock@2026', 10);
  const usersToEnsure = [
    { email: 'admin@muziclub.com', name: 'Harsh Vardhan (Super Admin)', role: ROLES.SUPER_ADMIN },
    { email: 'manager@muziclub.com', name: 'Priya Sharma (Store Manager)', role: ROLES.MANAGER },
    { email: 'admin@stereobliss.com', name: 'Harsh Vardhan (Super Admin)', role: ROLES.SUPER_ADMIN },
    { email: 'manager@stereobliss.com', name: 'Priya Sharma (Store Manager)', role: ROLES.MANAGER },
  ];

  for (const u of usersToEnsure) {
    const exists = await User.findOne({ email: u.email });
    if (!exists) {
      await User.create({
        name: u.name,
        email: u.email,
        passwordHash,
        role: u.role,
        isActive: true,
      });
    }
  }

  const superAdmin = (await User.findOne({ role: ROLES.SUPER_ADMIN }))!;

  // 3. Ensure App Settings
  let setting = await AppSetting.findOne();
  if (!setting) {
    setting = await AppSetting.create({
      companyName: 'Stereobliss Retail',
      storeName: 'Stereobliss Central Store',
      storeCode: 'CENTRAL',
      contactEmail: 'contact@stereobliss.com',
      contactPhone: '+91 98765 43210',
      address: 'Stereobliss Central Store, Pune, Maharashtra, India',
      currency: 'INR',
      currencySymbol: '₹',
      defaultLocation: location._id,
      managerApprovalThresholdValue: 3,
      timeZone: 'Asia/Kolkata',
    });
  } else {
    setting.companyName = 'Stereobliss Retail';
    setting.storeName = 'Stereobliss Central Store';
    setting.storeCode = 'CENTRAL';
    await setting.save();
  }

  // 4. Ensure Categories
  const categoryDefs = [
    { name: 'Guitars & Basses', code: 'GUITARS', description: 'Acoustic, classical, electric, and bass guitars' },
    { name: 'Keyboards & Pianos', code: 'KEYBOARDS', description: 'Digital stage pianos, synthesizers, and portable keyboards' },
    { name: 'Drums & Percussion', code: 'DRUMS', description: 'Acoustic kits, electronic drum sets, and percussion' },
    { name: 'Pro Audio & Microphones', code: 'AUDIO', description: 'Vocal microphones, studio monitors, and audio interfaces' },
    { name: 'Cables & Accessories', code: 'ACCESSORIES', description: 'Strings, picks, cables, instrument stands, and tuners' },
  ];

  const catMap = new Map<string, any>();
  for (const c of categoryDefs) {
    let cat = await Category.findOne({ code: c.code });
    if (!cat) {
      cat = await Category.create({ ...c, isActive: true });
    }
    catMap.set(c.code, cat);
  }

  // 5. Ensure Suppliers
  const supplierDefs = [
    { name: 'Yamaha Music India Pvt Ltd', contactPerson: 'Arun Nair', email: 'sales@yamahamusic.in', phone: '+91 124 485 3300' },
    { name: 'Furtados Music Distribution', contactPerson: 'Cyril Fernandes', email: 'distribution@furtados.in', phone: '+91 22 4287 5000' },
    { name: 'Bajaao Wholesale Division', contactPerson: 'Karan Mehra', email: 'b2b@bajaao.com', phone: '+91 22 6105 4321' },
    { name: 'Casio India Retail Support', contactPerson: 'Sanjay Rawat', email: 'support@casio.in', phone: '+91 11 6699 9200' },
  ];

  const supMap = new Map<string, any>();
  for (const s of supplierDefs) {
    let sup = await Supplier.findOne({ name: s.name });
    if (!sup) {
      sup = await Supplier.create({ ...s, isActive: true });
    }
    supMap.set(s.name, sup);
  }

  // 6. Clear past inventory data to insert pure, clean Muziclub records
  await Promise.all([
    Product.deleteMany({}),
    SerializedItem.deleteMany({}),
    StockMovement.deleteMany({}),
    Sale.deleteMany({}),
    InternalUsage.deleteMany({}),
  ]);

  // 7. Seed Authentic Muziclub Products
  const productsToSeed = [
    {
      name: 'Yamaha F310 Acoustic Guitar',
      sku: 'SKU-0001',
      brand: 'Yamaha',
      modelName: 'F310',
      category: catMap.get('GUITARS')._id,
      supplier: supMap.get('Yamaha Music India Pvt Ltd')._id,
      trackingMode: TRACKING_MODES.SERIALIZED,
      purchaseCost: 9200,
      defaultSellingPrice: 11500,
      color: 'Natural Wood',
      unitOfMeasure: 'pcs',
      minStockThreshold: 3,
      initialStock: 4,
      serials: ['YAM-F310-091', 'YAM-F310-092', 'YAM-F310-093', 'YAM-F310-094'],
    },
    {
      name: 'Fender Player Stratocaster Electric Guitar',
      sku: 'SKU-0002',
      brand: 'Fender',
      modelName: 'Player Strat',
      category: catMap.get('GUITARS')._id,
      supplier: supMap.get('Furtados Music Distribution')._id,
      trackingMode: TRACKING_MODES.SERIALIZED,
      purchaseCost: 58000,
      defaultSellingPrice: 74900,
      color: 'Sunburst',
      unitOfMeasure: 'pcs',
      minStockThreshold: 2,
      initialStock: 2,
      serials: ['MX24018291', 'MX24018292'],
    },
    {
      name: 'Casio CT-X700 61-Key Portable Arranger Keyboard',
      sku: 'SKU-0003',
      brand: 'Casio',
      modelName: 'CT-X700',
      category: catMap.get('KEYBOARDS')._id,
      supplier: supMap.get('Casio India Retail Support')._id,
      trackingMode: TRACKING_MODES.SERIALIZED,
      purchaseCost: 11800,
      defaultSellingPrice: 14995,
      color: 'Black',
      unitOfMeasure: 'pcs',
      minStockThreshold: 2,
      initialStock: 3,
      serials: ['CAS-CTX-4401', 'CAS-CTX-4402', 'CAS-CTX-4403'],
    },
    {
      name: 'Roland TD-02K V-Drums Electronic Drum Kit',
      sku: 'SKU-0004',
      brand: 'Roland',
      modelName: 'TD-02K',
      category: catMap.get('DRUMS')._id,
      supplier: supMap.get('Bajaao Wholesale Division')._id,
      trackingMode: TRACKING_MODES.SERIALIZED,
      purchaseCost: 32500,
      defaultSellingPrice: 39900,
      color: 'Black',
      unitOfMeasure: 'set',
      minStockThreshold: 2,
      initialStock: 2,
      serials: ['ROL-TD02-108', 'ROL-TD02-109'],
    },
    {
      name: 'Shure SM58-LC Cardioid Dynamic Vocal Microphone',
      sku: 'SKU-0005',
      brand: 'Shure',
      modelName: 'SM58-LC',
      category: catMap.get('AUDIO')._id,
      supplier: supMap.get('Furtados Music Distribution')._id,
      trackingMode: TRACKING_MODES.SERIALIZED,
      purchaseCost: 8400,
      defaultSellingPrice: 10800,
      color: 'Silver / Chrome',
      unitOfMeasure: 'pcs',
      minStockThreshold: 3,
      initialStock: 3,
      serials: ['SH-SM58-8821', 'SH-SM58-8822', 'SH-SM58-8823'],
    },
    {
      name: "D'Addario EXL110 Nickel Wound Regular Light Guitar Strings (10-46)",
      sku: 'SKU-0006',
      brand: "D'Addario",
      modelName: 'EXL110',
      category: catMap.get('ACCESSORIES')._id,
      supplier: supMap.get('Bajaao Wholesale Division')._id,
      trackingMode: TRACKING_MODES.QUANTITY,
      purchaseCost: 380,
      defaultSellingPrice: 580,
      color: 'Silver / Chrome',
      unitOfMeasure: 'pack',
      minStockThreshold: 10,
      initialStock: 40,
    },
    {
      name: 'Fender Deluxe 10ft Straight-to-Straight Tweed Cable',
      sku: 'SKU-0007',
      brand: 'Fender',
      modelName: 'Deluxe Tweed 10ft',
      category: catMap.get('ACCESSORIES')._id,
      supplier: supMap.get('Furtados Music Distribution')._id,
      trackingMode: TRACKING_MODES.QUANTITY,
      purchaseCost: 950,
      defaultSellingPrice: 1450,
      color: 'Natural Wood',
      unitOfMeasure: 'pcs',
      minStockThreshold: 5,
      initialStock: 15,
    },
    {
      name: 'Dunlop Tortex Standard 0.73mm Yellow Picks (Pack of 12)',
      sku: 'SKU-0008',
      brand: 'Stereobliss',
      modelName: 'Tortex 0.73',
      category: catMap.get('ACCESSORIES')._id,
      supplier: supMap.get('Bajaao Wholesale Division')._id,
      trackingMode: TRACKING_MODES.QUANTITY,
      purchaseCost: 220,
      defaultSellingPrice: 360,
      color: 'Gold',
      unitOfMeasure: 'pack',
      minStockThreshold: 5,
      initialStock: 25,
    },
  ];

  let assetCounter = 1;

  for (const pDef of productsToSeed) {
    const product = await Product.create({
      name: pDef.name,
      sku: pDef.sku,
      brand: pDef.brand,
      modelName: pDef.modelName,
      category: pDef.category,
      supplier: pDef.supplier,
      trackingMode: pDef.trackingMode,
      purchaseCost: pDef.purchaseCost,
      defaultSellingPrice: pDef.defaultSellingPrice,
      color: pDef.color,
      unitOfMeasure: pDef.unitOfMeasure,
      minStockThreshold: pDef.minStockThreshold,
      stockQuantity: {
        onHand: pDef.initialStock,
        reserved: 0,
        issuedInternal: 0,
        quarantined: 0,
      },
      locationStock: [
        {
          location: location._id,
          onHand: pDef.initialStock,
          reserved: 0,
          issuedInternal: 0,
          quarantined: 0,
        },
      ],
      isActive: true,
    });

    if (pDef.trackingMode === TRACKING_MODES.SERIALIZED && pDef.serials) {
      for (let i = 0; i < pDef.serials.length; i++) {
        const assetId = `AST-${String(assetCounter++).padStart(4, '0')}`;
        const serializedItem = await SerializedItem.create({
          assetId,
          manufacturerSerial: pDef.serials[i],
          product: product._id,
          unitCost: product.purchaseCost,
          location: location._id,
          status: SERIALIZED_STATUSES.AVAILABLE,
          condition: 'NEW',
          notes: 'Stereobliss Store Verified Inventory',
        });

        await StockMovement.create({
          product: product._id,
          serializedItem: serializedItem._id,
          location: location._id,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: 1,
          destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
          transactionRef: `INIT-${product.sku}`,
          transactionModel: 'Product',
          reason: 'Opening catalogue intake',
          performedBy: superAdmin._id,
        });
      }
    } else {
      await StockMovement.create({
        product: product._id,
        location: location._id,
        movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
        quantityDelta: pDef.initialStock,
        transactionRef: `INIT-${product.sku}`,
        transactionModel: 'Product',
        reason: 'Opening stock count verified',
        performedBy: superAdmin._id,
      });
    }
  }

  // 8. Create 2 Authentic Recent Customer Sales
  const guitarProduct = (await Product.findOne({ sku: 'SKU-0001' }))!;
  const cableProduct = (await Product.findOne({ sku: 'SKU-0007' }))!;
  const stringsProduct = (await Product.findOne({ sku: 'SKU-0006' }))!;

  // Sale 1: Student package (Yamaha F310 + Tweed cable)
  await Sale.create({
    invoiceNumber: 'INV-2026-0001',
    customerName: 'Rahul Deshmukh',
    customerPhone: '+91 98220 54321',
    customerEmail: 'rahul.deshmukh@gmail.com',
    location: location._id,
    paymentMethod: 'UPI',
    paymentStatus: 'PAID',
    status: 'COMPLETED',
    items: [
      {
        product: guitarProduct._id,
        quantity: 1,
        unitPrice: guitarProduct.defaultSellingPrice,
        subtotal: guitarProduct.defaultSellingPrice,
      },
      {
        product: cableProduct._id,
        quantity: 1,
        unitPrice: cableProduct.defaultSellingPrice,
        subtotal: cableProduct.defaultSellingPrice,
      },
    ],
    subtotal: guitarProduct.defaultSellingPrice + cableProduct.defaultSellingPrice,
    taxAmount: 0,
    grandTotal: guitarProduct.defaultSellingPrice + cableProduct.defaultSellingPrice,
    soldBy: superAdmin._id,
    createdAt: new Date(),
  });

  // Sale 2: Accessories sale
  await Sale.create({
    invoiceNumber: 'INV-2026-0002',
    customerName: 'Ananya Roy',
    customerPhone: '+91 99701 11223',
    customerEmail: 'ananya.roy@yahoo.co.in',
    location: location._id,
    paymentMethod: 'CASH',
    paymentStatus: 'PAID',
    status: 'COMPLETED',
    items: [
      {
        product: stringsProduct._id,
        quantity: 2,
        unitPrice: stringsProduct.defaultSellingPrice,
        subtotal: stringsProduct.defaultSellingPrice * 2,
      },
    ],
    subtotal: stringsProduct.defaultSellingPrice * 2,
    taxAmount: 0,
    grandTotal: stringsProduct.defaultSellingPrice * 2,
    soldBy: superAdmin._id,
    createdAt: new Date(),
  });

  // 9. Create 1 Active Instrument Academy Loan in InternalUsage
  const loanItem = await SerializedItem.findOne({ manufacturerSerial: 'YAM-F310-094' });
  if (loanItem) {
    loanItem.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
    await loanItem.save();

    await InternalUsage.create({
      issueReference: 'LOAN-2026-001',
      serializedItem: loanItem._id,
      product: loanItem.product,
      purpose: USAGE_PURPOSES.PRACTICE,
      assignedPerson: 'Aditya Joshi (Rental Customer)',
      assignedDepartment: 'Guitar Department',
      location: location._id,
      issueDate: new Date(),
      expectedReturnDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      status: USAGE_STATUSES.ACTIVE,
      issuedBy: superAdmin._id,
    });

    await StockMovement.create({
      product: loanItem.product,
      serializedItem: loanItem._id,
      location: location._id,
      movementType: MOVEMENT_TYPES.INTERNAL_ISSUE,
      quantityDelta: -1,
      sourceStatus: SERIALIZED_STATUSES.AVAILABLE,
      destinationStatus: SERIALIZED_STATUSES.ISSUED_INTERNAL,
      transactionRef: 'LOAN-2026-001',
      transactionModel: 'InternalUsage',
      reason: 'Issued for classroom training practice',
      performedBy: superAdmin._id,
    });
  }

  // 10. Ensure Automated Cron Report Configs in DB
  const reportConfigs = [
    { reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY, scheduleCron: '0 20 * * *', recipients: ['inventory@stereobliss.com', 'admin@stereobliss.com'] },
    { reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY, scheduleCron: '0 9 * * 1', recipients: ['management@stereobliss.com'] },
    { reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER, scheduleCron: '0 10 * * *', recipients: ['rentals@stereobliss.com'] },
    { reportType: REPORT_TYPES.LOW_STOCK_ALERT, scheduleCron: '0 8 * * *', recipients: ['procurement@stereobliss.com'] },
  ];

  for (const rc of reportConfigs) {
    const exists = await EmailReportConfig.findOne({ reportType: rc.reportType });
    if (!exists) {
      await EmailReportConfig.create({
        ...rc,
        timeZone: 'Asia/Kolkata',
        isEnabled: true,
      });
    }
  }

  console.log('[STEREOBLISS_SEED] Successfully seeded authentic Stereobliss music inventory and real live data!');
}

if (process.argv[1] && process.argv[1].endsWith('seedMuziclubRealData.ts')) {
  seedMuziclubRealData()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[MUZICLUB_SEED_ERROR]', err);
      process.exit(1);
    });
}
