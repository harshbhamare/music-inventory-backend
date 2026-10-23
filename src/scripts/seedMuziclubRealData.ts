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
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import {
  ROLES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  MOVEMENT_TYPES,
  USAGE_PURPOSES,
  USAGE_STATUSES,
  REPORT_TYPES,
  SALE_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  ITEM_CONDITIONS,
  MAINTENANCE_STATUSES,
  PURCHASE_STATUSES,
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

  // 6. Clear past inventory data to insert pure, clean Stereobliss records
  await Promise.all([
    Product.deleteMany({}),
    SerializedItem.deleteMany({}),
    StockMovement.deleteMany({}),
    Sale.deleteMany({}),
    Purchase.deleteMany({}),
    PurchaseReceipt.deleteMany({}),
    InternalUsage.deleteMany({}),
    MaintenanceRecord.deleteMany({}),
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

  // 8. Create Authentic Sales Across Recent Weeks
  const guitarProduct = (await Product.findOne({ sku: 'SKU-0001' }))!;
  const stratProduct = (await Product.findOne({ sku: 'SKU-0002' }))!;
  const keyboardProduct = (await Product.findOne({ sku: 'SKU-0003' }))!;
  const drumProduct = (await Product.findOne({ sku: 'SKU-0004' }))!;
  const micProduct = (await Product.findOne({ sku: 'SKU-0005' }))!;
  const stringsProduct = (await Product.findOne({ sku: 'SKU-0006' }))!;
  const cableProduct = (await Product.findOne({ sku: 'SKU-0007' }))!;
  const picksProduct = (await Product.findOne({ sku: 'SKU-0008' }))!;

  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Inward Purchase Orders & Receipts for Stock Inflow Visuals
  const po1 = await Purchase.create({
    purchaseOrderNumber: 'PO-2026-0001',
    supplier: supMap.get('Yamaha Music India Pvt Ltd')._id,
    orderDate: daysAgo(25),
    lineItems: [
      {
        product: guitarProduct._id,
        quantityOrdered: 4,
        quantityReceived: 4,
        unitCost: guitarProduct.purchaseCost,
        totalCost: guitarProduct.purchaseCost * 4,
      },
    ],
    subtotal: guitarProduct.purchaseCost * 4,
    additionalCosts: 0,
    totalCost: guitarProduct.purchaseCost * 4,
    status: PURCHASE_STATUSES.COMPLETED,
    destinationLocation: location._id,
    createdBy: superAdmin._id,
  });

  const po2 = await Purchase.create({
    purchaseOrderNumber: 'PO-2026-0002',
    supplier: supMap.get('Casio India Retail Support')._id,
    orderDate: daysAgo(16),
    lineItems: [
      {
        product: keyboardProduct._id,
        quantityOrdered: 3,
        quantityReceived: 3,
        unitCost: keyboardProduct.purchaseCost,
        totalCost: keyboardProduct.purchaseCost * 3,
      },
    ],
    subtotal: keyboardProduct.purchaseCost * 3,
    additionalCosts: 0,
    totalCost: keyboardProduct.purchaseCost * 3,
    status: PURCHASE_STATUSES.COMPLETED,
    destinationLocation: location._id,
    createdBy: superAdmin._id,
  });

  const po3 = await Purchase.create({
    purchaseOrderNumber: 'PO-2026-0003',
    supplier: supMap.get('Bajaao Wholesale Division')._id,
    orderDate: daysAgo(9),
    lineItems: [
      {
        product: stringsProduct._id,
        quantityOrdered: 20,
        quantityReceived: 20,
        unitCost: stringsProduct.purchaseCost,
        totalCost: stringsProduct.purchaseCost * 20,
      },
      {
        product: cableProduct._id,
        quantityOrdered: 10,
        quantityReceived: 10,
        unitCost: cableProduct.purchaseCost,
        totalCost: cableProduct.purchaseCost * 10,
      },
    ],
    subtotal: stringsProduct.purchaseCost * 20 + cableProduct.purchaseCost * 10,
    additionalCosts: 0,
    totalCost: stringsProduct.purchaseCost * 20 + cableProduct.purchaseCost * 10,
    status: PURCHASE_STATUSES.COMPLETED,
    destinationLocation: location._id,
    createdBy: superAdmin._id,
  });

  await PurchaseReceipt.create([
    {
      receiptNumber: 'REC-2026-001',
      purchase: po1._id,
      destinationLocation: location._id,
      receivedDate: daysAgo(21),
      lineItems: [
        { product: guitarProduct._id, quantityReceived: 4, unitCost: guitarProduct.purchaseCost },
      ],
      receivedBy: superAdmin._id,
    },
    {
      receiptNumber: 'REC-2026-002',
      purchase: po2._id,
      destinationLocation: location._id,
      receivedDate: daysAgo(14),
      lineItems: [
        { product: keyboardProduct._id, quantityReceived: 3, unitCost: keyboardProduct.purchaseCost },
      ],
      receivedBy: superAdmin._id,
    },
    {
      receiptNumber: 'REC-2026-003',
      purchase: po3._id,
      destinationLocation: location._id,
      receivedDate: daysAgo(7),
      lineItems: [
        { product: stringsProduct._id, quantityReceived: 20, unitCost: stringsProduct.purchaseCost },
        { product: cableProduct._id, quantityReceived: 10, unitCost: cableProduct.purchaseCost },
      ],
      receivedBy: superAdmin._id,
    },
  ]);

  // Multiple Customer Sales across weeks
  await Sale.create([
    {
      invoiceNumber: 'INV-2026-0001',
      customerName: 'Rahul Deshmukh',
      customerPhone: '+91 98220 54321',
      customerEmail: 'rahul.deshmukh@gmail.com',
      location: location._id,
      paymentMethod: PAYMENT_METHODS.UPI,
      paymentStatus: PAYMENT_STATUSES.PAID,
      saleStatus: SALE_STATUSES.CONFIRMED,
      lineItems: [
        {
          product: guitarProduct._id,
          quantity: 1,
          unitPrice: guitarProduct.defaultSellingPrice,
          discount: 0,
          total: guitarProduct.defaultSellingPrice,
        },
        {
          product: cableProduct._id,
          quantity: 1,
          unitPrice: cableProduct.defaultSellingPrice,
          discount: 0,
          total: cableProduct.defaultSellingPrice,
        },
      ],
      subtotal: guitarProduct.defaultSellingPrice + cableProduct.defaultSellingPrice,
      discountTotal: 0,
      taxableAmount: guitarProduct.defaultSellingPrice + cableProduct.defaultSellingPrice,
      cgstRate: 9,
      cgstAmount: 0,
      sgstRate: 9,
      sgstAmount: 0,
      taxTotal: 0,
      grandTotal: guitarProduct.defaultSellingPrice + cableProduct.defaultSellingPrice,
      soldBy: superAdmin._id,
      createdAt: daysAgo(2),
    },
    {
      invoiceNumber: 'INV-2026-0002',
      customerName: 'Ananya Roy',
      customerPhone: '+91 99701 11223',
      customerEmail: 'ananya.roy@yahoo.co.in',
      location: location._id,
      paymentMethod: PAYMENT_METHODS.CASH,
      paymentStatus: PAYMENT_STATUSES.PAID,
      saleStatus: SALE_STATUSES.CONFIRMED,
      lineItems: [
        {
          product: stringsProduct._id,
          quantity: 2,
          unitPrice: stringsProduct.defaultSellingPrice,
          discount: 0,
          total: stringsProduct.defaultSellingPrice * 2,
        },
        {
          product: picksProduct._id,
          quantity: 1,
          unitPrice: picksProduct.defaultSellingPrice,
          discount: 0,
          total: picksProduct.defaultSellingPrice,
        },
      ],
      subtotal: stringsProduct.defaultSellingPrice * 2 + picksProduct.defaultSellingPrice,
      discountTotal: 0,
      taxableAmount: stringsProduct.defaultSellingPrice * 2 + picksProduct.defaultSellingPrice,
      cgstRate: 9,
      cgstAmount: 0,
      sgstRate: 9,
      sgstAmount: 0,
      taxTotal: 0,
      grandTotal: stringsProduct.defaultSellingPrice * 2 + picksProduct.defaultSellingPrice,
      soldBy: superAdmin._id,
      createdAt: daysAgo(5),
    },
    {
      invoiceNumber: 'INV-2026-0003',
      customerName: 'Vikramaditya Shinde',
      customerPhone: '+91 98900 12345',
      customerEmail: 'vikram.shinde@outlook.com',
      location: location._id,
      paymentMethod: PAYMENT_METHODS.CARD,
      paymentStatus: PAYMENT_STATUSES.PAID,
      saleStatus: SALE_STATUSES.CONFIRMED,
      lineItems: [
        {
          product: keyboardProduct._id,
          quantity: 1,
          unitPrice: keyboardProduct.defaultSellingPrice,
          discount: 500,
          total: keyboardProduct.defaultSellingPrice - 500,
        },
      ],
      subtotal: keyboardProduct.defaultSellingPrice,
      discountTotal: 500,
      taxableAmount: keyboardProduct.defaultSellingPrice - 500,
      cgstRate: 9,
      cgstAmount: 0,
      sgstRate: 9,
      sgstAmount: 0,
      taxTotal: 0,
      grandTotal: keyboardProduct.defaultSellingPrice - 500,
      soldBy: superAdmin._id,
      createdAt: daysAgo(12),
    },
    {
      invoiceNumber: 'INV-2026-0004',
      customerName: 'Aarav Patel (Band Lead)',
      customerPhone: '+91 98231 99887',
      customerEmail: 'aarav.patel@gmail.com',
      location: location._id,
      paymentMethod: PAYMENT_METHODS.UPI,
      paymentStatus: PAYMENT_STATUSES.PAID,
      saleStatus: SALE_STATUSES.CONFIRMED,
      lineItems: [
        {
          product: micProduct._id,
          quantity: 1,
          unitPrice: micProduct.defaultSellingPrice,
          discount: 0,
          total: micProduct.defaultSellingPrice,
        },
      ],
      subtotal: micProduct.defaultSellingPrice,
      discountTotal: 0,
      taxableAmount: micProduct.defaultSellingPrice,
      cgstRate: 9,
      cgstAmount: 0,
      sgstRate: 9,
      sgstAmount: 0,
      taxTotal: 0,
      grandTotal: micProduct.defaultSellingPrice,
      soldBy: superAdmin._id,
      createdAt: daysAgo(18),
    },
  ]);

  // 9. Create Authentic Rental Agreements & Maintenance Records
  const loanGuitar = await SerializedItem.findOne({ manufacturerSerial: 'YAM-F310-094' });
  const loanKeyboard = await SerializedItem.findOne({ manufacturerSerial: 'CAS-CTX-4401' });
  const loanDrums = await SerializedItem.findOne({ manufacturerSerial: 'ROL-TD02-108' });
  const loanStrat = await SerializedItem.findOne({ manufacturerSerial: 'MX24018291' });
  const loanMic = await SerializedItem.findOne({ manufacturerSerial: 'SH-SM58-8821' });

  // Rental 1: Yamaha F310 Guitar - Highly Profitable 10-Month Rental (130% ROI)
  if (loanGuitar) {
    loanGuitar.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
    loanGuitar.assignedTo = 'Aditya Joshi';
    await loanGuitar.save();

    const guitarPayments: any[] = [];
    const monthlyRate = 1200;
    for (let m = 1; m <= 12; m++) {
      const pDueDate = new Date(now.getFullYear(), now.getMonth() - (10 - m), 5);
      const isPaid = m <= 10;
      guitarPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${pDueDate.toLocaleString('default', { month: 'short', year: 'numeric' })})`,
        dueDate: pDueDate,
        amountDue: monthlyRate,
        amountPaid: isPaid ? monthlyRate : 0,
        paidAt: isPaid ? pDueDate : undefined,
        paymentMethod: 'UPI',
        transactionRef: isPaid ? `UPI-YAM-RENT-M0${m}` : undefined,
        status: isPaid ? 'PAID' : (m === 11 ? 'DUE' : 'DUE'),
        notes: isPaid ? 'Paid on schedule via GPay' : undefined,
      });
    }

    await InternalUsage.create({
      issueReference: 'USE-2026-00001',
      purpose: USAGE_PURPOSES.PRACTICE,
      assignedPerson: 'Aditya Joshi (Acoustic Student)',
      assignedPersonContact: '+91 98221 11224',
      customerEmail: 'aditya.joshi@gmail.com',
      location: location._id,
      items: [
        {
          product: loanGuitar.product,
          serializedItemId: loanGuitar._id,
          quantityIssued: 1,
          quantityReturned: 0,
          issueCondition: ITEM_CONDITIONS.GOOD,
        },
      ],
      issueDate: daysAgo(300),
      expectedReturnDate: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
      status: USAGE_STATUSES.ACTIVE,
      isRental: true,
      lockInPeriodMonths: 12,
      securityDeposit: 3000,
      monthlyRent: 1200,
      includedAccessories: ['Padded Gig Bag', 'Guitar Strap', 'Clip-on Tuner'],
      monthlyPayments: guitarPayments,
      totalRentPaid: 12000,
      totalRentDue: 2400,
      issuedBy: superAdmin._id,
    });

    // Maintenance record on this guitar
    await MaintenanceRecord.create({
      recordReference: 'MAINT-2026-001',
      product: loanGuitar.product,
      serializedItem: loanGuitar._id,
      location: location._id,
      problemDescription: 'Fretboard oiling & new D\'Addario string setup',
      repairDetails: 'Hydrated fretboard, leveled action to 2.0mm, replaced strings',
      vendor: 'Stereobliss In-House Workshop',
      cost: 450,
      status: MAINTENANCE_STATUSES.COMPLETED,
      startedAt: daysAgo(90),
      completedAt: daysAgo(89),
      createdByUser: superAdmin._id,
      notes: 'Standard 6-month routine service for active rental client',
    });
  }

  // Rental 2: Casio CT-X700 Keyboard - Active 6-Month Rental (50.8% Capex Recouped)
  if (loanKeyboard) {
    loanKeyboard.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
    loanKeyboard.assignedTo = 'Rohan Deshmukh';
    await loanKeyboard.save();

    const keyboardPayments: any[] = [];
    const kMonthlyRate = 1500;
    for (let m = 1; m <= 6; m++) {
      const pDueDate = new Date(now.getFullYear(), now.getMonth() - (4 - m), 10);
      const isPaid = m <= 4;
      keyboardPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${pDueDate.toLocaleString('default', { month: 'short', year: 'numeric' })})`,
        dueDate: pDueDate,
        amountDue: kMonthlyRate,
        amountPaid: isPaid ? kMonthlyRate : 0,
        paidAt: isPaid ? pDueDate : undefined,
        paymentMethod: 'UPI',
        transactionRef: isPaid ? `UPI-CAS-RENT-M0${m}` : undefined,
        status: isPaid ? 'PAID' : 'DUE',
      });
    }

    await InternalUsage.create({
      issueReference: 'USE-2026-00002',
      purpose: USAGE_PURPOSES.CLASS,
      assignedPerson: 'Rohan Deshmukh (Keyboard Beginner)',
      assignedPersonContact: '+91 97654 32109',
      customerEmail: 'rohan.deshmukh@gmail.com',
      location: location._id,
      items: [
        {
          product: loanKeyboard.product,
          serializedItemId: loanKeyboard._id,
          quantityIssued: 1,
          quantityReturned: 0,
          issueCondition: ITEM_CONDITIONS.GOOD,
        },
      ],
      issueDate: daysAgo(120),
      expectedReturnDate: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
      status: USAGE_STATUSES.ACTIVE,
      isRental: true,
      lockInPeriodMonths: 6,
      securityDeposit: 5000,
      monthlyRent: 1500,
      includedAccessories: ['Heavy-Duty Keyboard Stand', 'Power Adapter & Cable'],
      monthlyPayments: keyboardPayments,
      totalRentPaid: 6000,
      totalRentDue: 3000,
      issuedBy: superAdmin._id,
    });
  }

  // Rental 3: Roland TD-02K V-Drums - Active with Overdue Month Alert
  if (loanDrums) {
    loanDrums.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
    loanDrums.assignedTo = 'Siddharth Menon';
    await loanDrums.save();

    const drumPayments: any[] = [];
    const drumRate = 3500;
    for (let m = 1; m <= 6; m++) {
      const pDueDate = new Date(now.getFullYear(), now.getMonth() - (2 - m), 15);
      const isPaid = m === 1;
      const isPastDue = m === 2;
      drumPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${pDueDate.toLocaleString('default', { month: 'short', year: 'numeric' })})`,
        dueDate: pDueDate,
        amountDue: drumRate,
        amountPaid: isPaid ? drumRate : 0,
        paidAt: isPaid ? pDueDate : undefined,
        paymentMethod: 'BANK_TRANSFER',
        status: isPaid ? 'PAID' : (isPastDue ? 'OVERDUE' : 'DUE'),
        notes: isPastDue ? 'Overdue reminder sent via WhatsApp' : undefined,
      });
    }

    await InternalUsage.create({
      issueReference: 'USE-2026-00003',
      purpose: USAGE_PURPOSES.PRACTICE,
      assignedPerson: 'Siddharth Menon (Session Drummer)',
      assignedPersonContact: '+91 99223 44556',
      customerEmail: 'siddharth.drums@gmail.com',
      location: location._id,
      items: [
        {
          product: loanDrums.product,
          serializedItemId: loanDrums._id,
          quantityIssued: 1,
          quantityReturned: 0,
          issueCondition: ITEM_CONDITIONS.NEW,
        },
      ],
      issueDate: daysAgo(50),
      expectedReturnDate: new Date(now.getTime() + 130 * 24 * 60 * 60 * 1000),
      status: USAGE_STATUSES.OVERDUE,
      isRental: true,
      lockInPeriodMonths: 6,
      securityDeposit: 10000,
      monthlyRent: 3500,
      includedAccessories: ['Drum Throne', 'Vic Firth 5A Drumsticks', 'Audio Cable'],
      monthlyPayments: drumPayments,
      totalRentPaid: 3500,
      totalRentDue: 17500,
      issuedBy: superAdmin._id,
    });
  }

  // Rental 4: Fender Player Stratocaster - Successfully Completed & Returned (₹27,000 revenue)
  if (loanStrat) {
    loanStrat.status = SERIALIZED_STATUSES.AVAILABLE;
    await loanStrat.save();

    const stratPayments: any[] = [];
    const stratRate = 4500;
    for (let m = 1; m <= 6; m++) {
      const pDueDate = new Date(now.getFullYear(), now.getMonth() - (8 - m), 1);
      stratPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${pDueDate.toLocaleString('default', { month: 'short', year: 'numeric' })})`,
        dueDate: pDueDate,
        amountDue: stratRate,
        amountPaid: stratRate,
        paidAt: pDueDate,
        paymentMethod: 'CARD',
        status: 'PAID',
      });
    }

    await InternalUsage.create({
      issueReference: 'USE-2026-00004',
      purpose: USAGE_PURPOSES.EVENT,
      assignedPerson: 'Meera Iyer (Jazz Performer)',
      assignedPersonContact: '+91 98110 99881',
      customerEmail: 'meera.iyer@livemusic.in',
      location: location._id,
      items: [
        {
          product: loanStrat.product,
          serializedItemId: loanStrat._id,
          quantityIssued: 1,
          quantityReturned: 1,
          issueCondition: ITEM_CONDITIONS.MINT,
        },
      ],
      issueDate: daysAgo(240),
      expectedReturnDate: daysAgo(60),
      actualReturnDate: daysAgo(60),
      status: USAGE_STATUSES.RETURNED,
      isRental: true,
      lockInPeriodMonths: 6,
      securityDeposit: 15000,
      monthlyRent: 4500,
      includedAccessories: ['Fender Hardcase', 'Fender Tweed Cable', 'Guitar Strap'],
      monthlyPayments: stratPayments,
      totalRentPaid: 27000,
      totalRentDue: 0,
      issuedBy: superAdmin._id,
    });
  }

  // Rental 5: Shure SM58 Vocal Microphone - Active 3-Month Rental
  if (loanMic) {
    loanMic.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
    loanMic.assignedTo = 'Kabir Verma';
    await loanMic.save();

    const micPayments: any[] = [];
    const micRate = 1000;
    for (let m = 1; m <= 3; m++) {
      const pDueDate = new Date(now.getFullYear(), now.getMonth() - (2 - m), 20);
      const isPaid = m <= 2;
      micPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${pDueDate.toLocaleString('default', { month: 'short', year: 'numeric' })})`,
        dueDate: pDueDate,
        amountDue: micRate,
        amountPaid: isPaid ? micRate : 0,
        paidAt: isPaid ? pDueDate : undefined,
        paymentMethod: 'UPI',
        status: isPaid ? 'PAID' : 'DUE',
      });
    }

    await InternalUsage.create({
      issueReference: 'USE-2026-00005',
      purpose: USAGE_PURPOSES.REHEARSAL,
      assignedPerson: 'Kabir Verma (Live Vocalist)',
      assignedPersonContact: '+91 98330 77665',
      customerEmail: 'kabir.verma@band.in',
      location: location._id,
      items: [
        {
          product: loanMic.product,
          serializedItemId: loanMic._id,
          quantityIssued: 1,
          quantityReturned: 0,
          issueCondition: ITEM_CONDITIONS.GOOD,
        },
      ],
      issueDate: daysAgo(45),
      expectedReturnDate: new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000),
      status: USAGE_STATUSES.ACTIVE,
      isRental: true,
      lockInPeriodMonths: 3,
      securityDeposit: 2500,
      monthlyRent: 1000,
      includedAccessories: ['Microphone Stand', 'XLR-to-XLR Cable (6m)', 'Mic Clip'],
      monthlyPayments: micPayments,
      totalRentPaid: 2000,
      totalRentDue: 1000,
      issuedBy: superAdmin._id,
    });
  }

  // 10. Ensure Automated Cron Report Configs in DB (including Rental Profitability)
  const reportConfigs = [
    {
      reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
      title: 'Daily Stock & Inventory Summary',
      scheduleCron: '0 20 * * *',
      recipients: ['inventory@stereobliss.com', 'admin@stereobliss.com'],
    },
    {
      reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
      title: 'Weekly Sales Performance Summary',
      scheduleCron: '0 9 * * 1',
      recipients: ['management@stereobliss.com'],
    },
    {
      reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
      title: 'Daily Overdue Instrument Loan Alerts',
      scheduleCron: '0 10 * * *',
      recipients: ['rentals@stereobliss.com'],
    },
    {
      reportType: REPORT_TYPES.LOW_STOCK_ALERT,
      title: 'Low Stock Safety Buffer Alert',
      scheduleCron: '0 8 * * *',
      recipients: ['procurement@stereobliss.com'],
    },
    {
      reportType: REPORT_TYPES.RENTAL_PROFITABILITY_REPORT,
      title: 'Rental Instrument Profitability & Fleet Yield Report',
      scheduleCron: '0 9 1 * *',
      recipients: ['management@stereobliss.com', 'finance@stereobliss.com'],
    },
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
