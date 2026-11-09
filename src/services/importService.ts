/**
 * Historical Data Import Service — Muziclub Inventory
 *
 * Provides:
 *   1. generateImportTemplate()  → Buffer (Excel .xlsx template with instructions, hints, and sample data)
 *   2. validateImportFile()      → ValidationResult (row-level errors, preview counts, robust format detection)
 *   3. executeImport()           → ImportResult (records created, stock reconciled, idempotent)
 *
 * Supported sheets (order respects foreign keys):
 *   1. Categories
 *   2. Suppliers
 *   3. Locations
 *   4. Products
 *   5. SerializedItems
 *   6. DirectSales
 *   7. EMISales
 *   8. EMIPayments
 *   9. Rentals
 *   10. RentalPayments
 *   11. PurchaseOrders
 */

import * as XLSX from 'xlsx';
import mongoose, { Types } from 'mongoose';

import { Category } from '../models/Category.js';
import { Supplier } from '../models/Supplier.js';
import { StockLocation } from '../models/StockLocation.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { Sale } from '../models/Sale.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { StockMovement } from '../models/StockMovement.js';

import {
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  ITEM_CONDITIONS,
  MOVEMENT_TYPES,
  SALE_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  SALE_TYPES,
  USAGE_STATUSES,
  USAGE_PURPOSES,
  PURCHASE_STATUSES,
} from '../config/constants.js';
import { AuthenticatedUser } from '../middleware/auth.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface RowError {
  sheet: string;
  row: number;   // 1-based Excel row number
  field: string;
  message: string;
}

export interface ValidationPreview {
  categories: number;
  suppliers: number;
  locations: number;
  products: number;
  serializedItems: number;
  directSales: number;
  emiSales: number;
  emiPaymentRows: number;
  rentals: number;
  rentalPaymentRows: number;
  purchaseOrders: number;
}

export interface ValidationResult {
  valid: boolean;
  totalRows: number;
  validRows: number;
  skippedRows: number;
  errorCount: number;
  errors: RowError[];
  preview: ValidationPreview;
}

export interface ImportResult {
  success: boolean;
  durationMs: number;
  skipped: number;
  errors: RowError[];
  imported: {
    categories: number;
    suppliers: number;
    locations: number;
    products: number;
    serializedItems: number;
    sales: number;
    emiSales: number;
    rentals: number;
    purchaseOrders: number;
    stockMovements: number;
  };
}

// ─── Robust Normalization & Parsing Helpers ────────────────────────────────────

/** Parse dates from Excel serial numbers, DD/MM/YYYY, YYYY-MM-DD, or ISO strings */
export function parseDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  const s = String(val).trim();
  if (!s) return null;

  // 1. Excel serial number (numeric date)
  const n = Number(s);
  if (!isNaN(n) && n > 1000 && n < 100000) {
    const ssf = (XLSX as any).SSF || (XLSX as any).default?.SSF;
    if (ssf?.parse_date_code) {
      const parsed = ssf.parse_date_code(Math.floor(n));
      if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
    // Pure math fallback for Excel serial date
    const epochUtc = Math.round((n - 25569) * 86400 * 1000);
    const d = new Date(epochUtc);
    if (!isNaN(d.getTime())) return d;
  }

  // 2. YYYY-MM-DD or YYYY/MM/DD
  const yyyymmdd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (yyyymmdd) {
    const year = parseInt(yyyymmdd[1], 10);
    const month = parseInt(yyyymmdd[2], 10) - 1;
    const day = parseInt(yyyymmdd[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return d;
  }

  // 3. DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY (Standard Indian format)
  const ddmmyyyy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (ddmmyyyy) {
    const day = parseInt(ddmmyyyy[1], 10);
    const month = parseInt(ddmmyyyy[2], 10) - 1;
    const year = parseInt(ddmmyyyy[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return d;
  }

  // 4. DD-MM-YY or DD/MM/YY
  const ddmmyy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (ddmmyy) {
    const day = parseInt(ddmmyy[1], 10);
    const month = parseInt(ddmmyy[2], 10) - 1;
    let year = parseInt(ddmmyy[3], 10);
    year += year < 50 ? 2000 : 1900;
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return d;
  }

  // 5. Standard Date parsing fallback
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse numeric values, stripping currency symbols (₹, Rs, Rs., $, INR), commas, and whitespace */
export function parseNum(val: unknown, def = 0): number {
  if (val === null || val === undefined) return def;
  if (typeof val === 'number') return isNaN(val) ? def : val;
  let s = String(val).trim();
  if (!s) return def;
  s = s.replace(/[₹$,]/g, '')
    .replace(/^(rs\.?|inr)\s*/i, '')
    .replace(/\s*(rs\.?|inr)$/i, '')
    .trim();
  const n = Number(s);
  return isNaN(n) ? def : n;
}

/** Check if value represents a valid number (handles ₹, Rs, commas) */
export function isNumeric(val: unknown): boolean {
  if (val === null || val === undefined || val === '') return false;
  if (typeof val === 'number') return !isNaN(val);
  const s = String(val).trim()
    .replace(/[₹$,]/g, '')
    .replace(/^(rs\.?|inr)\s*/i, '')
    .replace(/\s*(rs\.?|inr)$/i, '')
    .trim();
  return s !== '' && !isNaN(Number(s));
}

/** Parse booleans */
export function parseBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  const s = String(val ?? '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES' || s === 'Y' || s === 'T';
}

/** Clean raw cell header string */
function cleanHeader(h: unknown): string {
  return String(h ?? '').trim();
}

/** Map any raw user column title to standard internal key */
export function normalizeHeaderKey(header: string, sheetName?: string): string {
  const norm = header.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Sheet-specific overrides
  if (sheetName) {
    const s = sheetName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (s.includes('category') || s.includes('categories')) {
      if (['name', 'categoryname', 'category', 'catname', 'title'].includes(norm)) return 'name';
    }
    if (s.includes('supplier')) {
      if (['name', 'suppliername', 'supplier', 'vendor', 'vendorname'].includes(norm)) return 'name';
    }
    if (s.includes('location')) {
      if (['name', 'locationname', 'storename', 'store', 'branch'].includes(norm)) return 'name';
      if (['code', 'shortcode', 'locationcode', 'loccode'].includes(norm)) return 'code';
    }
    if (s.includes('product')) {
      if (['name', 'productname', 'itemname', 'title', 'product', 'item'].includes(norm)) return 'name';
    }
    if (s.includes('rental') && !s.includes('payment')) {
      if (['customername', 'assignedperson', 'rentername', 'renter', 'customer', 'name'].includes(norm)) return 'assignedPerson';
      if (['customerphone', 'assignedpersoncontact', 'renterphone', 'phone', 'mobile', 'contact'].includes(norm)) return 'assignedPersonContact';
    }
    if (s.includes('purchase')) {
      if (['ponumber', 'pono', 'purchaseordernumber', 'purchaseorder', 'po'].includes(norm)) return 'poNumber';
    }
  }

  // Global comprehensive dictionary
  const dict: Record<string, string> = {
    // Basic identifiers
    name: 'name',
    productname: 'name',
    itemname: 'name',
    locationname: 'name',
    storename: 'name',
    description: 'description',
    desc: 'description',
    details: 'description',
    notes: 'notes',
    remarks: 'notes',
    comment: 'notes',
    comments: 'notes',

    // People & Contact
    contactperson: 'contactPerson',
    poc: 'contactPerson',
    email: 'email',
    emailaddress: 'email',
    phone: 'phone',
    phonenumber: 'phone',
    mobile: 'phone',
    mobilenumber: 'phone',
    tel: 'phone',
    contactno: 'phone',
    address: 'address',
    addr: 'address',

    // Locations
    code: 'code',
    shortcode: 'code',
    locationcode: 'code',
    isdefault: 'isDefault',
    type: 'type',

    // Products
    sku: 'sku',
    skucode: 'sku',
    productsku: 'productSku',
    itemcode: 'sku',
    category: 'category',
    categoryname: 'category',
    brand: 'brand',
    brandname: 'brand',
    model: 'modelName',
    modelname: 'modelName',
    modelseriesname: 'modelName',
    modelseries: 'modelName',
    seriesname: 'modelName',
    color: 'color',
    colour: 'color',
    finish: 'color',
    colorfinish: 'color',
    hsn: 'hsnCode',
    hsncode: 'hsnCode',
    sac: 'hsnCode',
    tracking: 'trackingMode',
    trackingmode: 'trackingMode',
    uom: 'unitOfMeasure',
    unitofmeasure: 'unitOfMeasure',
    unit: 'unitOfMeasure',
    purchasecost: 'purchaseCost',
    cost: 'purchaseCost',
    costprice: 'purchaseCost',
    buyprice: 'purchaseCost',
    buyingprice: 'purchaseCost',
    sellingprice: 'sellingPrice',
    retailprice: 'sellingPrice',
    price: 'sellingPrice',
    unitprice: 'unitPrice',
    rate: 'unitPrice',
    mrp: 'sellingPrice',
    saleprice: 'sellingPrice',
    defaultsellingprice: 'sellingPrice',
    openingstock: 'openingStock',
    stock: 'openingStock',
    initialstock: 'openingStock',
    location: 'location',
    supplier: 'supplier',
    suppliername: 'supplier',
    vendor: 'supplier',
    minstock: 'minStockThreshold',
    minstockthreshold: 'minStockThreshold',
    lowstockalert: 'minStockThreshold',
    reorderlevel: 'minStockThreshold',

    // Serialized Items
    assetid: 'assetId',
    assettag: 'assetId',
    serialid: 'assetId',
    tagid: 'assetId',
    manufacturerserial: 'manufacturerSerial',
    mfrserial: 'manufacturerSerial',
    mfrserialno: 'manufacturerSerial',
    serialno: 'manufacturerSerial',
    serialnumber: 'manufacturerSerial',
    serial: 'manufacturerSerial',
    unitcost: 'unitCost',
    status: 'status',
    condition: 'condition',
    warrantyexpiry: 'warrantyExpiry',
    warrantyexpirydate: 'warrantyExpiry',
    warranty: 'warrantyExpiry',

    // Direct Sales & EMI Sales
    invoicenumber: 'invoiceNumber',
    invoiceno: 'invoiceNumber',
    invno: 'invoiceNumber',
    billno: 'invoiceNumber',
    invoice: 'invoiceNumber',
    date: 'date',
    saledate: 'date',
    invoicedate: 'date',
    billdate: 'date',
    customername: 'customerName',
    clientname: 'customerName',
    customer: 'customerName',
    buyername: 'customerName',
    customeremail: 'customerEmail',
    clientemail: 'customerEmail',
    buyeremail: 'customerEmail',
    customerphone: 'customerPhone',
    customermobile: 'customerPhone',
    customergstin: 'customerGstin',
    gstin: 'customerGstin',
    gst: 'customerGstin',
    gstno: 'customerGstin',
    customeraddress: 'customerAddress',
    quantity: 'quantity',
    qty: 'quantity',
    units: 'quantity',
    count: 'quantity',
    discount: 'discount',
    disc: 'discount',
    paymentmethod: 'paymentMethod',
    paymentmode: 'paymentMethod',
    paymentstatus: 'paymentStatus',
    dispatchthrough: 'dispatchThrough',
    destination: 'destination',
    ewaybillno: 'eWayBillNo',
    ewaybill: 'eWayBillNo',
    downpayment: 'downPayment',
    advance: 'downPayment',
    initialpayment: 'downPayment',
    emitenuremonths: 'emiTenureMonths',
    emitenure: 'emiTenureMonths',
    tenure: 'emiTenureMonths',
    months: 'emiTenureMonths',
    noofmonths: 'emiTenureMonths',
    downpaymentmethod: 'downPaymentMethod',

    // Instalments / Payments
    monthindex: 'monthIndex',
    monthno: 'monthIndex',
    month: 'monthIndex',
    instalmentno: 'monthIndex',
    installmentno: 'monthIndex',
    billingmonth: 'billingMonth',
    monthlabel: 'billingMonth',
    duedate: 'dueDate',
    amountdue: 'amountDue',
    due: 'amountDue',
    amountpaid: 'amountPaid',
    paid: 'amountPaid',
    paiddate: 'paidDate',
    datepaid: 'paidDate',
    transactionref: 'transactionRef',
    transactionno: 'transactionRef',
    txnref: 'transactionRef',
    trnref: 'transactionRef',
    utr: 'transactionRef',

    // Rentals
    issuereference: 'issueReference',
    referenceno: 'issueReference',
    refno: 'issueReference',
    rentalref: 'issueReference',
    issuedate: 'issueDate',
    expectedreturndate: 'expectedReturnDate',
    returnbydate: 'expectedReturnDate',
    returndate: 'expectedReturnDate',
    actualreturndate: 'actualReturnDate',
    assignedperson: 'assignedPerson',
    assignedpersoncontact: 'assignedPersonContact',
    monthlyrent: 'monthlyRent',
    rent: 'monthlyRent',
    rentamount: 'monthlyRent',
    securitydeposit: 'securityDeposit',
    deposit: 'securityDeposit',
    deposittransactionref: 'depositTransactionRef',
    deposittxnref: 'depositTransactionRef',
    depositmode: 'depositMode',
    depositbalance: 'depositBalance',
    depositrefundstatus: 'depositRefundStatus',
    lockinperiodmonths: 'lockInPeriodMonths',
    lockinmonths: 'lockInPeriodMonths',
    lockin: 'lockInPeriodMonths',
    includedaccessories: 'includedAccessories',
    accessories: 'includedAccessories',
    purpose: 'purpose',

    // Purchase orders
    ponumber: 'poNumber',
    purchaseordernumber: 'poNumber',
    orderdate: 'orderDate',
    podate: 'orderDate',
    quantityordered: 'quantityOrdered',
    qtyordered: 'quantityOrdered',
    orderedqty: 'quantityOrdered',
    quantityreceived: 'quantityReceived',
    qtyreceived: 'quantityReceived',
    receivedqty: 'quantityReceived',
    invoicereference: 'invoiceReference',
  };

  return dict[norm] || header;
}

/** Find worksheet with fuzzy matching (spaces, underscores, case, aliases) */
export function findSheet(wb: XLSX.WorkBook, canonicalName: string): XLSX.WorkSheet | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(canonicalName);

  // Exact match
  if (wb.Sheets[canonicalName]) return wb.Sheets[canonicalName];

  // Normalized match
  const found = wb.SheetNames.find(sn => norm(sn) === target);
  if (found && wb.Sheets[found]) return wb.Sheets[found];

  // Common aliases
  const aliases: Record<string, string[]> = {
    categories: ['category', 'categories', 'cats'],
    suppliers: ['supplier', 'suppliers', 'vendors', 'vendor'],
    locations: ['location', 'locations', 'stocklocation', 'stocklocations', 'stores', 'store', 'branches', 'branch'],
    products: ['product', 'products', 'items', 'item', 'inventory'],
    serializeditems: ['serializeditem', 'serializeditems', 'serialized', 'assets', 'asset', 'serialitems', 'serials'],
    directsales: ['directsale', 'directsales', 'sales', 'sale', 'invoices', 'retail'],
    emisales: ['emisale', 'emisales', 'emi', 'emis', 'loans', 'installmentsales'],
    emipayments: ['emipayment', 'emipayments', 'emiinstallments', 'emiinstalments', 'installments', 'instalments', 'emidues'],
    rentals: ['rental', 'rentals', 'internalusage', 'usage', 'rents', 'leases'],
    rentalpayments: ['rentalpayment', 'rentalpayments', 'rentaldues', 'rentpayments', 'rentdues'],
    purchaseorders: ['purchaseorder', 'purchaseorders', 'purchases', 'purchase', 'po', 'pos', 'orders'],
  };

  const aliasList = aliases[target] || [];
  for (const name of wb.SheetNames) {
    if (aliasList.includes(norm(name))) {
      return wb.Sheets[name];
    }
  }
  return null;
}

/** Check if row 2 is a hint/note row rather than actual data */
function isHintRow(row: unknown[]): boolean {
  if (!row || !Array.isArray(row)) return false;
  const text = row.map(c => String(c ?? '').trim()).join(' ');
  if (!text) return false;
  const upper = text.toUpperCase();
  return (
    upper.includes('REQUIRED') ||
    upper.includes('MUST MATCH') ||
    upper.includes('E.G.') ||
    upper.includes('YYYY-MM-DD') ||
    upper.includes('LEAVE BLANK') ||
    upper.includes('NUMBER ONLY') ||
    upper.includes('FOR QUANTITY MODE') ||
    upper.includes('DEFAULTS TO')
  );
}

/** Convert worksheet to standardized row objects, auto-detecting hint row presence */
export function sheetToRows(
  ws: XLSX.WorkSheet,
  sheetName?: string
): { rows: Record<string, string>[]; startRowIndex: number } {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
  if (!aoa || aoa.length < 2) return { rows: [], startRowIndex: 2 };

  const rawHeaders = (aoa[0] as unknown[]).map(h => cleanHeader(h));
  const mappedKeys = rawHeaders.map(h => normalizeHeaderKey(h, sheetName));

  // Determine whether row 1 (the 2nd row) is a hint/note row
  let dataRows: unknown[][];
  let startRowIndex = 2; // 1-based Excel row number for the first data row

  if (aoa.length >= 3 && isHintRow(aoa[1] as unknown[])) {
    dataRows = aoa.slice(2);
    startRowIndex = 3; // header=row 1, hints=row 2, data=row 3
  } else {
    dataRows = aoa.slice(1);
    startRowIndex = 2; // header=row 1, data=row 2
  }

  const rows = dataRows
    .map(row => {
      const obj: Record<string, string> = {};
      mappedKeys.forEach((key, i) => {
        const rawHeader = rawHeaders[i];
        if (!rawHeader) return;
        const rawKey = rawHeader.replace(/\s*\*$/, '').trim();
        const val = String((row as unknown[])[i] ?? '').trim();
        if (key) obj[key] = val;
        if (rawKey && !obj[rawKey]) obj[rawKey] = val;
      });

      // Preserve aliases used by older import templates and rental sheets.
      if (obj['customerName'] && !obj['assignedPerson']) obj['assignedPerson'] = obj['customerName'];
      if (obj['assignedPerson'] && !obj['customerName']) obj['customerName'] = obj['assignedPerson'];
      if (obj['customerPhone'] && !obj['assignedPersonContact']) obj['assignedPersonContact'] = obj['customerPhone'];
      if (obj['assignedPersonContact'] && !obj['customerPhone']) obj['customerPhone'] = obj['assignedPersonContact'];
      if (obj['poNumber'] && !obj['purchaseOrderNumber']) obj['purchaseOrderNumber'] = obj['poNumber'];
      if (obj['purchaseOrderNumber'] && !obj['poNumber']) obj['poNumber'] = obj['purchaseOrderNumber'];
      if (obj['sku'] && !obj['productSku']) obj['productSku'] = obj['sku'];
      if (obj['productSku'] && !obj['sku']) obj['sku'] = obj['productSku'];
      if (obj['purchaseCost'] && !obj['unitCost']) obj['unitCost'] = obj['purchaseCost'];
      if (obj['unitCost'] && !obj['purchaseCost']) obj['purchaseCost'] = obj['unitCost'];
      if (obj['sellingPrice'] && !obj['unitPrice']) obj['unitPrice'] = obj['sellingPrice'];
      if (obj['unitPrice'] && !obj['sellingPrice']) obj['sellingPrice'] = obj['unitPrice'];

      return obj;
    })
    .filter(r => Object.values(r).some(v => v !== ''));

  return { rows, startRowIndex };
}

// ─── Enum Normalizers ─────────────────────────────────────────────────────────

export function normalizePaymentMethod(val: string): string {
  if (!val) return PAYMENT_METHODS.CASH;
  const v = val.trim().toUpperCase().replace(/[\s_\-]+/g, '');
  if (['UPI', 'GPAY', 'GOOGLEPAY', 'PHONEPE', 'PAYTM', 'BHIM'].includes(v)) return PAYMENT_METHODS.UPI;
  if (['CASH', 'COD'].includes(v)) return PAYMENT_METHODS.CASH;
  if (['CARD', 'DEBIT', 'CREDIT', 'DEBITCARD', 'CREDITCARD', 'POS', 'SWIPE'].includes(v)) return PAYMENT_METHODS.CARD;
  if (['BANKTRANSFER', 'BANK', 'IMPS', 'NEFT', 'RTGS', 'ONLINE', 'TRANSFER', 'NETBANKING'].includes(v)) return PAYMENT_METHODS.BANK_TRANSFER;
  return PAYMENT_METHODS.OTHER;
}

export function normalizeTrackingMode(val: string): string {
  if (!val) return TRACKING_MODES.QUANTITY;
  const v = val.trim().toUpperCase();
  if (v.startsWith('SER') || v === 'S') return TRACKING_MODES.SERIALIZED;
  return TRACKING_MODES.QUANTITY;
}

export function normalizeCondition(val: string): string {
  if (!val) return ITEM_CONDITIONS.NEW;
  const v = val.trim().toUpperCase();
  if (Object.values(ITEM_CONDITIONS).includes(v as any)) return v;
  return ITEM_CONDITIONS.GOOD;
}

export function normalizeSerializedStatus(val: string): string {
  if (!val) return SERIALIZED_STATUSES.AVAILABLE;
  const v = val.trim().toUpperCase().replace(/[\s\-]+/g, '_');
  if (Object.values(SERIALIZED_STATUSES).includes(v as any)) return v;
  return SERIALIZED_STATUSES.AVAILABLE;
}

export function normalizePaymentStatus(val: string): string {
  if (!val) return PAYMENT_STATUSES.PAID;
  const v = val.trim().toUpperCase();
  if (Object.values(PAYMENT_STATUSES).includes(v as any)) return v;
  return PAYMENT_STATUSES.PAID;
}

export function normalizeRentalStatus(val: string): string {
  if (!val) return USAGE_STATUSES.ACTIVE;
  const v = val.trim().toUpperCase().replace(/[\s\-]+/g, '_');
  if (Object.values(USAGE_STATUSES).includes(v as any)) return v;
  return USAGE_STATUSES.ACTIVE;
}

export function normalizeRentalPurpose(val: string): string {
  if (!val) return USAGE_PURPOSES.CLASS;
  const v = val.trim().toUpperCase();
  if (Object.values(USAGE_PURPOSES).includes(v as any)) return v;
  return USAGE_PURPOSES.CLASS;
}

export function normalizePOStatus(val: string): string {
  if (!val) return PURCHASE_STATUSES.COMPLETED;
  const v = val.trim().toUpperCase().replace(/[\s\-]+/g, '_');
  if (Object.values(PURCHASE_STATUSES).includes(v as any)) return v;
  return PURCHASE_STATUSES.COMPLETED;
}

// ─── Column Definitions for the Template ─────────────────────────────────────

interface ColDef {
  header: string;
  key: string;
  width: number;
  required?: boolean;
  hint?: string;
  example?: string | number;
}

export const SHEET_COLS: Record<string, ColDef[]> = {
  Categories: [
    { header: 'Category Name', key: 'name', width: 28, required: true, example: 'Guitars' },
    { header: 'Description', key: 'description', width: 44, required: false, example: 'Acoustic and electric guitars' },
  ],
  Suppliers: [
    { header: 'Supplier Name', key: 'name', width: 30, required: true, example: 'Furtados Music' },
    { header: 'Contact Person', key: 'contactPerson', width: 25, required: false, example: 'Raj Kumar' },
    { header: 'Email', key: 'email', width: 30, required: false, example: 'raj@furtados.com' },
    { header: 'Phone', key: 'phone', width: 18, required: false, example: '9820012345' },
    { header: 'Address', key: 'address', width: 35, required: false, example: 'Pune' },
  ],
  Locations: [
    { header: 'Location Name', key: 'name', width: 28, required: true, example: 'Main Store' },
    { header: 'Short Code', key: 'code', width: 14, required: true, hint: 'e.g. MAIN', example: 'MAIN' },
    { header: 'Is Default?', key: 'isDefault', width: 14, required: false, hint: 'TRUE or FALSE', example: 'TRUE' },
  ],
  Products: [
    { header: 'Brand', key: 'brand', width: 20, required: false, example: 'Yamaha' },
    { header: 'Product Name', key: 'name', width: 32, required: true, example: 'Yamaha F310 Acoustic Guitar' },
    { header: 'Model / Series', key: 'modelName', width: 20, required: false, hint: 'e.g. F310, Pacifica', example: 'F310' },
    { header: 'Category', key: 'category', width: 22, required: true, hint: 'Must match Category Name', example: 'Guitars' },
    { header: 'Color / Finish', key: 'color', width: 18, required: false, example: 'Natural' },
    { header: 'HSN Code', key: 'hsnCode', width: 14, required: false, hint: 'Default: 9202', example: '9202' },
    { header: 'Low Stock Alert', key: 'minStockThreshold', width: 16, required: false, hint: 'Default: 5', example: 5 },
    { header: 'Unit of Measure', key: 'unitOfMeasure', width: 16, required: false, hint: 'pcs / set / unit', example: 'pcs' },
    { header: 'Tracking Mode', key: 'trackingMode', width: 18, required: false, hint: 'QUANTITY or SERIALIZED', example: 'SERIALIZED' },
    { header: 'Purchase Cost', key: 'purchaseCost', width: 16, required: true, hint: 'Number only, no symbol', example: 6000 },
    { header: 'Selling Price', key: 'sellingPrice', width: 16, required: true, hint: 'Number only, no symbol', example: 8500 },
    { header: 'Opening Stock', key: 'openingStock', width: 16, required: false, hint: 'For QUANTITY or default stock', example: 4 },
    { header: 'Location Code', key: 'location', width: 18, required: false, hint: 'Where stock lives', example: 'MAIN' },
    { header: 'Supplier', key: 'supplier', width: 24, required: false, hint: 'Must match Supplier Name', example: 'Furtados Music' },
    { header: 'SKU Code', key: 'sku', width: 16, required: false, hint: 'Leave blank to auto-generate', example: 'SKU-0001' },
    { header: 'Description', key: 'description', width: 36, required: false, example: 'Spruce top acoustic guitar' },
  ],
  SerializedItems: [
    { header: 'Asset ID', key: 'assetId', width: 20, required: true, hint: 'Unique tag e.g. F310-001', example: 'F310-001' },
    { header: 'Product SKU', key: 'productSku', width: 18, required: true, hint: 'Must match SKU Code', example: 'SKU-0001' },
    { header: 'Mfr Serial No.', key: 'manufacturerSerial', width: 22, required: false, example: 'YMH123456' },
    { header: 'Purchase Cost', key: 'unitCost', width: 14, required: true, example: 6000 },
    { header: 'Location', key: 'location', width: 18, required: true, example: 'MAIN' },
    { header: 'Status', key: 'status', width: 18, required: false, hint: 'AVAILABLE or SOLD', example: 'AVAILABLE' },
    { header: 'Condition', key: 'condition', width: 14, required: false, hint: 'NEW / GOOD / FAIR / POOR', example: 'NEW' },
    { header: 'Warranty Expiry', key: 'warrantyExpiry', width: 18, required: false, hint: 'YYYY-MM-DD', example: '2026-12-31' },
    { header: 'Notes', key: 'notes', width: 24, required: false, example: 'Inspected and verified' },
  ],
  DirectSales: [
    { header: 'Invoice No.', key: 'invoiceNumber', width: 20, required: true, hint: 'Same No. for multi-item sale', example: 'INV-2024-0001' },
    { header: 'Sale Date', key: 'date', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-01-15' },
    { header: 'Customer Name', key: 'customerName', width: 26, required: true, example: 'Rahul Sharma' },
    { header: 'Customer Email', key: 'customerEmail', width: 30, required: true, example: 'rahul@gmail.com' },
    { header: 'Customer Phone', key: 'customerPhone', width: 16, required: true, example: '9876543210' },
    { header: 'Customer GSTIN', key: 'customerGstin', width: 18, required: false, hint: '15-digit GSTIN', example: '27AAAAA0000A1Z5' },
    { header: 'Customer Address', key: 'customerAddress', width: 32, required: false, example: 'FC Road, Pune, MH' },
    { header: 'Product SKU', key: 'productSku', width: 18, required: true, example: 'SKU-0001' },
    { header: 'HSN Code', key: 'hsnCode', width: 12, required: false, hint: 'Default: 9202', example: '9202' },
    { header: 'Qty', key: 'quantity', width: 8, required: true, example: 1 },
    { header: 'Unit Price', key: 'unitPrice', width: 14, required: true, hint: 'Number only', example: 8500 },
    { header: 'Discount', key: 'discount', width: 12, required: false, hint: 'Per-unit discount, default 0', example: 0 },
    { header: 'Asset ID', key: 'assetId', width: 16, required: false, hint: 'For serialized products', example: 'F310-001' },
    { header: 'Payment Method', key: 'paymentMethod', width: 18, required: true, hint: 'CASH / UPI / CARD / BANK_TRANSFER', example: 'UPI' },
  ],
  EMISales: [
    { header: 'Invoice No.', key: 'invoiceNumber', width: 20, required: true, hint: 'Same No. for multi-item sale', example: 'INV-2024-0010' },
    { header: 'Sale Date', key: 'date', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-02-01' },
    { header: 'Customer Name', key: 'customerName', width: 26, required: true, example: 'Priya Desai' },
    { header: 'Customer Email', key: 'customerEmail', width: 30, required: true, example: 'priya@gmail.com' },
    { header: 'Customer Phone', key: 'customerPhone', width: 16, required: true, example: '9988776655' },
    { header: 'Customer GSTIN', key: 'customerGstin', width: 18, required: false, example: '27AAAAA0000A1Z5' },
    { header: 'Customer Address', key: 'customerAddress', width: 32, required: false, example: 'Kothrud, Pune, MH' },
    { header: 'Product SKU', key: 'productSku', width: 18, required: true, example: 'SKU-0002' },
    { header: 'Qty', key: 'quantity', width: 8, required: true, example: 1 },
    { header: 'Unit Price', key: 'unitPrice', width: 14, required: true, example: 7200 },
    { header: 'Down Payment', key: 'downPayment', width: 16, required: true, hint: 'Amount paid upfront', example: 1200 },
    { header: 'No. of Months', key: 'emiTenureMonths', width: 16, required: true, hint: 'Total EMI instalments', example: 6 },
    { header: 'Down Payment Method', key: 'downPaymentMethod', width: 20, required: false, hint: 'CASH / UPI / CARD / BANK_TRANSFER', example: 'UPI' },
  ],
  EMIPayments: [
    { header: 'Invoice No.', key: 'invoiceNumber', width: 20, required: true, hint: 'Must match EMI Sales Invoice No.', example: 'INV-2024-0010' },
    { header: 'Month No.', key: 'monthIndex', width: 12, required: true, hint: '1 for first instalment', example: 1 },
    { header: 'Month Label', key: 'billingMonth', width: 24, required: false, hint: 'e.g. Month 1 (Mar 2024)', example: 'Month 1 (Mar 2024)' },
    { header: 'Due Date', key: 'dueDate', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-03-01' },
    { header: 'Amount Due', key: 'amountDue', width: 14, required: true, example: 1000 },
    { header: 'Amount Paid', key: 'amountPaid', width: 14, required: false, hint: '0 if unpaid', example: 1000 },
    { header: 'Date Paid', key: 'paidDate', width: 14, required: false, hint: 'YYYY-MM-DD, blank if unpaid', example: '2024-03-05' },
    { header: 'Payment Method', key: 'paymentMethod', width: 18, required: false, example: 'UPI' },
    { header: 'Transaction Ref', key: 'transactionRef', width: 26, required: false, example: 'UPI-998001' },
    { header: 'Status', key: 'status', width: 12, required: true, hint: 'PAID / DUE / OVERDUE', example: 'PAID' },
  ],
  Rentals: [
    { header: 'Reference No.', key: 'issueReference', width: 22, required: true, hint: 'e.g. USE-2024-00001', example: 'USE-2024-00001' },
    { header: 'Issue Date', key: 'issueDate', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-03-01' },
    { header: 'Return By Date', key: 'expectedReturnDate', width: 18, required: true, hint: 'YYYY-MM-DD', example: '2024-06-01' },
    { header: 'Actual Return Date', key: 'actualReturnDate', width: 18, required: false, hint: 'YYYY-MM-DD (if returned)', example: '2024-06-01' },
    { header: 'Customer Name', key: 'assignedPerson', width: 26, required: true, example: 'Amit Joshi' },
    { header: 'Customer Phone', key: 'assignedPersonContact', width: 18, required: false, example: '9123456780' },
    { header: 'Customer Email', key: 'customerEmail', width: 30, required: false, example: 'amit@gmail.com' },
    { header: 'Product SKU', key: 'productSku', width: 18, required: true, example: 'SKU-0001' },
    { header: 'Asset ID', key: 'assetId', width: 16, required: false, example: 'F310-001' },
    { header: 'Monthly Rent', key: 'monthlyRent', width: 14, required: true, hint: 'Number only', example: 1500 },
    { header: 'Lock-In Months', key: 'lockInPeriodMonths', width: 16, required: false, hint: 'Tenure (default: 3)', example: 3 },
    { header: 'Security Deposit', key: 'securityDeposit', width: 18, required: false, hint: 'Number only, 0 if none', example: 5000 },
    { header: 'Deposit Mode', key: 'depositMode', width: 14, required: false, hint: 'TRUE or FALSE', example: 'FALSE' },
    { header: 'Deposit Balance', key: 'depositBalance', width: 16, required: false, hint: 'Remaining deposit balance', example: 5000 },
    { header: 'Deposit Refund Status', key: 'depositRefundStatus', width: 22, required: false, hint: 'HELD / REFUND_PENDING / REFUNDED', example: 'HELD' },
    { header: 'Deposit Txn Ref', key: 'depositTransactionRef', width: 20, required: false, example: 'CASH-001' },
    { header: 'Status', key: 'status', width: 20, required: false, hint: 'ACTIVE / RETURNED / OVERDUE', example: 'ACTIVE' },
    { header: 'Accessories', key: 'includedAccessories', width: 36, required: false, hint: 'Comma-separated', example: 'Stand, Power Adapter' },
  ],
  RentalPayments: [
    { header: 'Reference No.', key: 'issueReference', width: 22, required: true, hint: 'Must match Rental Reference No.', example: 'USE-2024-00001' },
    { header: 'Month No.', key: 'monthIndex', width: 12, required: true, example: 1 },
    { header: 'Month Label', key: 'billingMonth', width: 24, required: false, example: 'Month 1 (Mar 2024)' },
    { header: 'Due Date', key: 'dueDate', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-03-01' },
    { header: 'Amount Due', key: 'amountDue', width: 14, required: true, example: 1500 },
    { header: 'Amount Paid', key: 'amountPaid', width: 14, required: false, example: 1500 },
    { header: 'Date Paid', key: 'paidDate', width: 14, required: false, hint: 'YYYY-MM-DD', example: '2024-03-03' },
    { header: 'Payment Method', key: 'paymentMethod', width: 18, required: false, example: 'CASH' },
    { header: 'Transaction Ref', key: 'transactionRef', width: 26, required: false, example: 'CASH-R001' },
    { header: 'Status', key: 'status', width: 12, required: true, hint: 'PAID / DUE / OVERDUE', example: 'PAID' },
  ],
  PurchaseOrders: [
    { header: 'PO Number', key: 'purchaseOrderNumber', width: 20, required: true, hint: 'Same No. for multi-item PO', example: 'PO-2024-0001' },
    { header: 'Order Date', key: 'orderDate', width: 14, required: true, hint: 'YYYY-MM-DD', example: '2024-01-05' },
    { header: 'Supplier', key: 'supplier', width: 26, required: true, hint: 'Must match Supplier Name', example: 'Furtados Music' },
    { header: 'Product SKU', key: 'productSku', width: 18, required: true, example: 'SKU-0001' },
    { header: 'Qty Ordered', key: 'quantityOrdered', width: 14, required: true, example: 3 },
    { header: 'Qty Received', key: 'quantityReceived', width: 14, required: false, hint: 'Defaults to Qty Ordered', example: 3 },
    { header: 'Unit Cost', key: 'unitCost', width: 14, required: true, hint: 'Number only', example: 6000 },
    { header: 'Invoice Reference', key: 'invoiceReference', width: 24, required: false, example: 'FURT-INV-001' },
    { header: 'Status', key: 'status', width: 22, required: false, hint: 'COMPLETED / DRAFT', example: 'COMPLETED' },
    { header: 'Location', key: 'location', width: 18, required: false, example: 'MAIN' },
  ],
};

// ─── 1. Template Generation ───────────────────────────────────────────────────

export function generateImportTemplate(): Buffer {
  const wb = XLSX.utils.book_new();

  // ── HOW TO USE Sheet ──
  const howToUse = [
    ['MUZICLUB INVENTORY — Historical Data Import Guide', '', '', ''],
    [''],
    ['STEP 1: FILL SHEETS IN ORDER (Left to Right tabs)', '', '', ''],
    ['', '1. Categories  2. Suppliers  3. Locations  4. Products  5. Serialized Items', '', ''],
    ['', '6. Direct Sales  7. EMI Sales  8. EMI Payments  9. Rentals  10. Rental Payments  11. Purchase Orders', '', ''],
    [''],
    ['STEP 2: SHEET STRUCTURE', '', '', ''],
    ['', 'Row 1 = Column Header (Required columns have blue header, optional have gray)', '', ''],
    ['', 'Row 2 = Helpful hints, expected format, or allowed values', '', ''],
    ['', 'Row 3+ = Your data (the sample row shown can be deleted or replaced)', '', ''],
    [''],
    ['STEP 3: UPLOAD & PREVIEW', '', '', ''],
    ['', 'Upload your completed Excel file on the Data Import screen.', '', ''],
    ['', 'Review the validation summary and preview counts before committing.', '', ''],
    [''],
    ['KEY RULES & RESILIENT FEATURES', '', '', ''],
    ['', '• Date formats supported: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, or Excel date numbers.', '', ''],
    ['', '• Amounts: clean numbers or numbers with currency/commas (e.g. 8500 or ₹8,500) are both accepted.', '', ''],
    ['', '• Multi-item Sales or POs: simply repeat the same Invoice No. / PO Number across multiple rows.', '', ''],
    ['', '• Missing SKU code: leave SKU Code blank and an auto-generated SKU will be assigned.', '', ''],
    ['', '• Missing Category / Supplier: automatically created if not already listed.', '', ''],
    ['', '• Existing records: automatically skipped to prevent accidental duplicate entries.', '', ''],
    [''],
    ['ALLOWED ENUM VALUES (Case-Insensitive)', '', '', ''],
    ['', 'Payment Method:', 'UPI  |  CASH  |  CARD  |  BANK_TRANSFER  |  OTHER (GPay/PhonePe recognized as UPI)', ''],
    ['', 'Tracking Mode:', 'QUANTITY  |  SERIALIZED', ''],
    ['', 'Condition:', 'NEW  |  MINT  |  GOOD  |  FAIR  |  POOR  |  DAMAGED (Default: NEW)', ''],
    ['', 'Serialized Status:', 'AVAILABLE  |  SOLD  |  ISSUED_INTERNAL  |  MAINTENANCE  |  QUARANTINED', ''],
    ['', 'Rental Status:', 'ACTIVE  |  RETURNED  |  PARTIALLY_RETURNED  |  OVERDUE', ''],
    ['', 'EMI / Rental Payment Status:', 'PAID  |  DUE  |  OVERDUE', ''],
    ['', 'Purchase Order Status:', 'COMPLETED  |  PARTIALLY_RECEIVED  |  CONFIRMED  |  DRAFT', ''],
  ];

  const wsHow = XLSX.utils.aoa_to_sheet(howToUse);
  wsHow['!cols'] = [{ wch: 14 }, { wch: 80 }, { wch: 60 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsHow, 'HOW TO USE');

  // ── Data Sheets ──
  for (const [sheetName, cols] of Object.entries(SHEET_COLS)) {
    const headerRow = cols.map(c => c.header);
    const hintRow = cols.map(c => {
      const parts: string[] = [];
      if (c.required) parts.push('REQUIRED');
      if (c.hint) parts.push(c.hint);
      return parts.join(' — ');
    });
    const exampleRow = cols.map(c => (c.example !== undefined ? c.example : ''));

    // Second sample row for Products to show both SERIALIZED and QUANTITY modes
    const extraRows: (string | number)[][] = [];
    if (sheetName === 'Products') {
      extraRows.push([
        'Casio',
        'Casio CT-X700 Portable Keyboard',
        'CT-X700',
        'Keyboards',
        'Black',
        '9207',
        5,
        'pcs',
        'QUANTITY',
        5500,
        7200,
        4,
        'MAIN',
        'Furtados Music',
        'SKU-0002',
        'Portable keyboard',
      ]);
    } else if (sheetName === 'Categories') {
      extraRows.push(['Keyboards', 'Digital pianos, synthesizers and workstations']);
    }

    const ws = XLSX.utils.aoa_to_sheet([headerRow, hintRow, exampleRow, ...extraRows]);
    ws['!cols'] = cols.map(c => ({ wch: c.width }));

    // Style header and hint rows where the XLSX writer supports cell styles.
    cols.forEach((col, ci) => {
      const cellAddr = XLSX.utils.encode_cell({ r: 0, c: ci });
      if (!ws[cellAddr]) ws[cellAddr] = { v: col.header, t: 's' };
      ws[cellAddr].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: col.required ? '1A6EB7' : '4A5568' } },
        alignment: { horizontal: 'left' },
        border: { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } },
      };
      const hintAddr = XLSX.utils.encode_cell({ r: 1, c: ci });
      if (!ws[hintAddr]) ws[hintAddr] = { v: hintRow[ci], t: 's' };
      ws[hintAddr].s = {
        font: { italic: true, color: { rgb: '718096' }, sz: 9 },
        fill: { fgColor: { rgb: 'F7FAFC' } },
      };
    });

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ─── 2. Validation ────────────────────────────────────────────────────────────

export async function validateImportFile(buf: Buffer): Promise<ValidationResult> {
  const wb = XLSX.read(buf, { type: 'buffer', raw: false });
  const errors: RowError[] = [];
  let total = 0, valid = 0, skipped = 0;

  const preview: ValidationResult['preview'] = {
    categories: 0,
    suppliers: 0,
    locations: 0,
    products: 0,
    serializedItems: 0,
    directSales: 0,
    emiSales: 0,
    emiPaymentRows: 0,
    rentals: 0,
    rentalPaymentRows: 0,
    purchaseOrders: 0,
  };

  // Helper validation checks
  const requireField = (sheet: string, row: number, field: string, val: string): boolean => {
    if (!val || val.trim() === '') {
      errors.push({ sheet, row, field, message: `${field} is required` });
      return false;
    }
    return true;
  };

  const mustBeNum = (sheet: string, row: number, field: string, val: string): boolean => {
    if (val !== '' && !isNumeric(val)) {
      errors.push({ sheet, row, field, message: `${field} must be a valid number` });
      return false;
    }
    return true;
  };


  const mustBeEnum = (
    sheet: string,
    row: number,
    field: string,
    val: string,
    allowedValues: string[]
  ): boolean => {
    const normalizedValue = String(val ?? '').trim().toUpperCase();

    // Empty values are allowed when the field is optional.
    if (!normalizedValue) return true;

    const allowed = new Set(
      allowedValues.map(value => String(value).trim().toUpperCase())
    );

    if (!allowed.has(normalizedValue)) {
      errors.push({
        sheet,
        row,
        field,
        message: `${field} must be one of: ${allowedValues.filter(Boolean).join(', ')}`,
      });
      return false;
    }

    return true;
  };

  const mustBeDate = (sheet: string, row: number, field: string, val: string): boolean => {
    if (val && !parseDate(val)) {
      errors.push({ sheet, row, field, message: `${field} must be a valid date (YYYY-MM-DD or DD/MM/YYYY)` });
      return false;
    }
    return true;
  };

  // Cross-sheet reference sets (populated from DB first, augmented from file)
  const catNames = new Set<string>();
  const supplierNames = new Set<string>();
  const locCodes = new Set<string>();
  const prodSkus = new Set<string>();
  const prodNames = new Set<string>();
  const assetIds = new Set<string>();
  const emiInvoices = new Set<string>();
  const rentalRefs = new Set<string>();

  // Pre-load from DB (if connected)
  if (mongoose.connection.readyState === 1) {
    try {
      (await Category.find({}, { name: 1 }).lean()).forEach((c: any) => catNames.add(c.name.trim().toLowerCase()));
      (await Supplier.find({}, { name: 1 }).lean() as any[]).forEach((s: any) => supplierNames.add(s.name.trim().toLowerCase()));
      (await StockLocation.find({}, { code: 1, name: 1 }).lean()).forEach((l: any) => {
        locCodes.add(l.code.trim().toUpperCase());
        locCodes.add(l.name.trim().toLowerCase());
      });
      (await Product.find({}, { sku: 1, name: 1 }).lean()).forEach((p: any) => {
        prodSkus.add(p.sku.trim().toUpperCase());
        prodNames.add(p.name.trim().toLowerCase());
      });
      (await SerializedItem.find({}, { assetId: 1 }).lean()).forEach((a: any) => assetIds.add(a.assetId.trim().toUpperCase()));
    } catch {
      // Gracefully continue if DB read times out or fails
    }
  }

  const readSheet = (name: string): { rows: Record<string, string>[]; startRowIndex: number } => {
    const ws = findSheet(wb, name);
    return ws ? sheetToRows(ws, name) : { rows: [], startRowIndex: 2 };
  };

  // ── 1. Categories ──
  const { rows: catRows, startRowIndex: catStart } = readSheet('Categories');
  catRows.forEach((r, i) => {
    total++;
    const rowNum = catStart + i;
    if (!requireField('Categories', rowNum, 'Category Name', r['name'])) {
      skipped++;
      return;
    }
    catNames.add(r['name'].trim().toLowerCase());
    preview.categories++;
    valid++;
  });

  // ── 2. Suppliers ──
  const { rows: suppRows, startRowIndex: suppStart } = readSheet('Suppliers');
  suppRows.forEach((r, i) => {
    total++;
    const rowNum = suppStart + i;
    if (!requireField('Suppliers', rowNum, 'Supplier Name', r['name'])) {
      skipped++;
      return;
    }
    supplierNames.add(r['name'].trim().toLowerCase());
    preview.suppliers++;
    valid++;
  });

  // ── 3. Locations ──
  const { rows: locRows, startRowIndex: locStart } = readSheet('Locations');
  locRows.forEach((r, i) => {
    total++;
    const rowNum = locStart + i;
    let ok = true;
    ok = requireField('Locations', rowNum, 'Location Name', r['name']) && ok;
    ok = requireField('Locations', rowNum, 'Short Code', r['code']) && ok;
    if (!ok) {
      skipped++;
      return;
    }
    locCodes.add(r['code'].trim().toUpperCase());
    locCodes.add(r['name'].trim().toLowerCase());
    preview.locations++;
    valid++;
  });

  // ── 4. Products ──
  const seenSkus = new Set<string>();
  const { rows: prodRows, startRowIndex: prodStart } = readSheet('Products');
  prodRows.forEach((r, i) => {
    total++;
    const rowNum = prodStart + i;
    let ok = true;
    ok = requireField('Products', rowNum, 'Product Name', r['name']) && ok;

    // Category auto-registers if not present
    if (r['category']?.trim()) {
      catNames.add(r['category'].trim().toLowerCase());
    } else {
      ok = requireField('Products', rowNum, 'Category', r['category']) && ok;
    }

    if (r['supplier']?.trim()) {
      supplierNames.add(r['supplier'].trim().toLowerCase());
    }

    ok = requireField('Products', rowNum, 'Purchase Cost', r['purchaseCost']) && ok;
    ok = mustBeNum('Products', rowNum, 'Purchase Cost', r['purchaseCost']) && ok;
    ok = requireField('Products', rowNum, 'Selling Price', r['sellingPrice']) && ok;
    ok = mustBeNum('Products', rowNum, 'Selling Price', r['sellingPrice']) && ok;
    ok = mustBeNum('Products', rowNum, 'Opening Stock', r['openingStock']) && ok;

    const sku = r['sku'] ? r['sku'].trim().toUpperCase() : '';
    if (sku) {
      if (seenSkus.has(sku)) {
        errors.push({ sheet: 'Products', row: rowNum, field: 'SKU Code', message: `Duplicate SKU "${sku}" in file` });
        ok = false;
      }
      seenSkus.add(sku);
    }

    if (!ok) {
      skipped++;
      return;
    }

    if (sku) prodSkus.add(sku);
    if (r['name']) prodNames.add(r['name'].trim().toLowerCase());
    preview.products++;
    valid++;
  });

  // Helper: check if a SKU or Product Name matches any known product
  const isValidProductRef = (ref: string): boolean => {
    if (!ref) return false;
    const clean = ref.trim();
    return prodSkus.has(clean.toUpperCase()) || prodNames.has(clean.toLowerCase());
  };

  // ── 5. SerializedItems ──
  const seenAssets = new Set<string>();
  const { rows: serialRows, startRowIndex: serialStart } = readSheet('SerializedItems');
  serialRows.forEach((r, i) => {
    total++;
    const rowNum = serialStart + i;
    let ok = true;
    ok = requireField('SerializedItems', rowNum, 'Asset ID', r['assetId']) && ok;
    ok = requireField('SerializedItems', rowNum, 'Product SKU', r['productSku']) && ok;

    const asset = r['assetId'] ? r['assetId'].trim().toUpperCase() : '';
    if (asset && seenAssets.has(asset)) {
      errors.push({ sheet: 'SerializedItems', row: rowNum, field: 'Asset ID', message: `Duplicate Asset ID "${asset}" in file` });
      ok = false;
    } else if (asset && assetIds.has(asset)) {
      // Note: existing asset in DB is skipped during import (not a hard error)
    }

    if (r['productSku'] && !isValidProductRef(r['productSku'])) {
      errors.push({ sheet: 'SerializedItems', row: rowNum, field: 'Product SKU', message: `Product "${r['productSku']}" not found in Products sheet or database` });
      ok = false;
    }

    ok = mustBeNum('SerializedItems', rowNum, 'Purchase Cost', r['unitCost']) && ok;
    ok = mustBeDate('SerializedItems', rowNum, 'Warranty Expiry', r['warrantyExpiry']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    if (asset) {
      seenAssets.add(asset);
      assetIds.add(asset);
    }
    preview.serializedItems++;
    valid++;
  });

  // ── 6. DirectSales ──
  const seenDirectInvoices = new Set<string>();
  const { rows: saleRows, startRowIndex: saleStart } = readSheet('DirectSales');
  saleRows.forEach((r, i) => {
    total++;
    const rowNum = saleStart + i;
    let ok = true;
    ok = requireField('DirectSales', rowNum, 'Invoice No.', r['invoiceNumber']) && ok;
    ok = requireField('DirectSales', rowNum, 'Sale Date', r['date']) && ok;
    ok = mustBeDate('DirectSales', rowNum, 'Sale Date', r['date']) && ok;
    ok = requireField('DirectSales', rowNum, 'Customer Name', r['customerName']) && ok;
    ok = requireField('DirectSales', rowNum, 'Product SKU', r['productSku']) && ok;

    if (r['productSku'] && !isValidProductRef(r['productSku'])) {
      errors.push({ sheet: 'DirectSales', row: rowNum, field: 'Product SKU', message: `Product "${r['productSku']}" not found in Products sheet or database` });
      ok = false;
    }

    ok = mustBeNum('DirectSales', rowNum, 'Qty', r['quantity']) && ok;
    ok = mustBeNum('DirectSales', rowNum, 'Unit Price', r['unitPrice']) && ok;
    ok = mustBeNum('DirectSales', rowNum, 'Discount', r['discount']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    if (r['invoiceNumber']) {
      seenDirectInvoices.add(r['invoiceNumber'].trim().toUpperCase());
    }
    preview.directSales++;
    valid++;
  });

  // ── 7. EMISales ──
  const { rows: emiRows, startRowIndex: emiStart } = readSheet('EMISales');
  emiRows.forEach((r, i) => {
    total++;
    const rowNum = emiStart + i;
    let ok = true;
    ok = requireField('EMISales', rowNum, 'Invoice No.', r['invoiceNumber']) && ok;
    ok = requireField('EMISales', rowNum, 'Sale Date', r['date']) && ok;
    ok = mustBeDate('EMISales', rowNum, 'Sale Date', r['date']) && ok;
    ok = requireField('EMISales', rowNum, 'Customer Name', r['customerName']) && ok;
    ok = requireField('EMISales', rowNum, 'Product SKU', r['productSku']) && ok;

    if (r['productSku'] && !isValidProductRef(r['productSku'])) {
      errors.push({ sheet: 'EMISales', row: rowNum, field: 'Product SKU', message: `Product "${r['productSku']}" not found in Products sheet or database` });
      ok = false;
    }

    ok = mustBeNum('EMISales', rowNum, 'Qty', r['quantity']) && ok;
    ok = mustBeNum('EMISales', rowNum, 'Unit Price', r['unitPrice']) && ok;
    ok = mustBeNum('EMISales', rowNum, 'Down Payment', r['downPayment']) && ok;
    ok = requireField('EMISales', rowNum, 'No. of Months', r['emiTenureMonths']) && ok;
    ok = mustBeNum('EMISales', rowNum, 'No. of Months', r['emiTenureMonths']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    if (r['invoiceNumber']) {
      emiInvoices.add(r['invoiceNumber'].trim().toUpperCase());
    }
    preview.emiSales++;
    valid++;
  });

  // ── 8. EMIPayments ──
  const { rows: emiPayRows, startRowIndex: emiPayStart } = readSheet('EMIPayments');
  emiPayRows.forEach((r, i) => {
    total++;
    const rowNum = emiPayStart + i;
    let ok = true;
    ok = requireField('EMIPayments', rowNum, 'Invoice No.', r['invoiceNumber']) && ok;
    ok = requireField('EMIPayments', rowNum, 'Month No.', r['monthIndex']) && ok;
    ok = mustBeNum('EMIPayments', rowNum, 'Month No.', r['monthIndex']) && ok;
    ok = requireField('EMIPayments', rowNum, 'Due Date', r['dueDate']) && ok;
    ok = mustBeDate('EMIPayments', rowNum, 'Due Date', r['dueDate']) && ok;
    ok = requireField('EMIPayments', rowNum, 'Amount Due', r['amountDue']) && ok;
    ok = mustBeNum('EMIPayments', rowNum, 'Amount Due', r['amountDue']) && ok;
    ok = mustBeNum('EMIPayments', rowNum, 'Amount Paid', r['amountPaid']) && ok;
    ok = mustBeDate('EMIPayments', rowNum, 'Date Paid', r['paidDate']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    preview.emiPaymentRows++;
    valid++;
  });

  // ── 9. Rentals ──
  const seenRefs = new Set<string>();
  const { rows: rentalRows, startRowIndex: rentalStart } = readSheet('Rentals');
  rentalRows.forEach((r, i) => {
    total++;
    const rowNum = rentalStart + i;
    let ok = true;
    ok = requireField('Rentals', rowNum, 'Reference No.', r['issueReference']) && ok;
    ok = requireField('Rentals', rowNum, 'Issue Date', r['issueDate']) && ok;
    ok = mustBeDate('Rentals', rowNum, 'Issue Date', r['issueDate']) && ok;
    ok = requireField('Rentals', rowNum, 'Return By Date', r['expectedReturnDate']) && ok;
    ok = mustBeDate('Rentals', rowNum, 'Return By Date', r['expectedReturnDate']) && ok;
    ok = mustBeDate('Rentals', rowNum, 'Actual Return Date', r['actualReturnDate']) && ok;
    ok = requireField('Rentals', rowNum, 'Customer Name', r['assignedPerson']) && ok;
    ok = requireField('Rentals', rowNum, 'Product SKU', r['productSku']) && ok;

    if (r['productSku'] && !isValidProductRef(r['productSku'])) {
      errors.push({ sheet: 'Rentals', row: rowNum, field: 'Product SKU', message: `Product "${r['productSku']}" not found in Products sheet or database` });
      ok = false;
    }
    ok = requireField('Rentals', rowNum, 'Monthly Rent', r['monthlyRent']) && ok;
    ok = mustBeNum('Rentals', rowNum, 'Monthly Rent', r['monthlyRent']) && ok;
    ok = mustBeNum('Rentals', rowNum, 'Security Deposit', r['securityDeposit']) && ok;
    ok = mustBeEnum('Rentals', rowNum, 'status', r['status'], ['', ...Object.values(USAGE_STATUSES)]) && ok;
    ok = mustBeEnum('Rentals', rowNum, 'purpose', r['purpose'], ['', ...Object.values(USAGE_PURPOSES)]) && ok;
    ok = mustBeEnum('Rentals', rowNum, 'depositRefundStatus', r['depositRefundStatus'], ['', 'HELD', 'REFUND_PENDING', 'REFUNDED']) && ok;
    ok = mustBeNum('Rentals', rowNum, 'lockInPeriodMonths', r['lockInPeriodMonths']) && ok;
    ok = mustBeNum('Rentals', rowNum, 'depositBalance', r['depositBalance']) && ok;

    const ref = r['issueReference'] ? r['issueReference'].trim().toUpperCase() : '';
    if (ref && seenRefs.has(ref)) {
      errors.push({ sheet: 'Rentals', row: rowNum, field: 'Reference No.', message: `Duplicate Reference No. "${ref}" in file` });
      ok = false;
    }

    if (!ok) {
      skipped++;
      return;
    }

    if (ref) {
      seenRefs.add(ref);
      rentalRefs.add(ref);
    }
    preview.rentals++;
    valid++;
  });

  // ── 10. RentalPayments ──
  const { rows: rentPayRows, startRowIndex: rentPayStart } = readSheet('RentalPayments');
  rentPayRows.forEach((r, i) => {
    total++;
    const rowNum = rentPayStart + i;
    let ok = true;
    ok = requireField('RentalPayments', rowNum, 'Reference No.', r['issueReference']) && ok;
    ok = requireField('RentalPayments', rowNum, 'Month No.', r['monthIndex']) && ok;
    ok = mustBeNum('RentalPayments', rowNum, 'Month No.', r['monthIndex']) && ok;
    ok = requireField('RentalPayments', rowNum, 'Due Date', r['dueDate']) && ok;
    ok = mustBeDate('RentalPayments', rowNum, 'Due Date', r['dueDate']) && ok;
    ok = requireField('RentalPayments', rowNum, 'Amount Due', r['amountDue']) && ok;
    ok = mustBeNum('RentalPayments', rowNum, 'Amount Due', r['amountDue']) && ok;
    ok = mustBeNum('RentalPayments', rowNum, 'Amount Paid', r['amountPaid']) && ok;
    ok = mustBeDate('RentalPayments', rowNum, 'Date Paid', r['paidDate']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    preview.rentalPaymentRows++;
    valid++;
  });

  // ── 11. PurchaseOrders ──
  const { rows: poRows, startRowIndex: poStart } = readSheet('PurchaseOrders');
  poRows.forEach((r, i) => {
    total++;
    const rowNum = poStart + i;
    let ok = true;
    ok = requireField('PurchaseOrders', rowNum, 'PO Number', r['poNumber']) && ok;
    ok = requireField('PurchaseOrders', rowNum, 'Order Date', r['orderDate']) && ok;
    ok = mustBeDate('PurchaseOrders', rowNum, 'Order Date', r['orderDate']) && ok;
    ok = requireField('PurchaseOrders', rowNum, 'Supplier', r['supplier']) && ok;
    ok = requireField('PurchaseOrders', rowNum, 'Product SKU', r['productSku']) && ok;

    if (r['productSku'] && !isValidProductRef(r['productSku'])) {
      errors.push({ sheet: 'PurchaseOrders', row: rowNum, field: 'Product SKU', message: `Product "${r['productSku']}" not found in Products sheet or database` });
      ok = false;
    }

    ok = requireField('PurchaseOrders', rowNum, 'Qty Ordered', r['quantityOrdered']) && ok;
    ok = mustBeNum('PurchaseOrders', rowNum, 'Qty Ordered', r['quantityOrdered']) && ok;
    ok = mustBeNum('PurchaseOrders', rowNum, 'Qty Received', r['quantityReceived']) && ok;
    ok = requireField('PurchaseOrders', rowNum, 'Unit Cost', r['unitCost']) && ok;
    ok = mustBeNum('PurchaseOrders', rowNum, 'Unit Cost', r['unitCost']) && ok;

    if (!ok) {
      skipped++;
      return;
    }

    preview.purchaseOrders++;
    valid++;
  });

  return {
    valid: errors.length === 0,
    totalRows: total,
    validRows: valid,
    skippedRows: skipped,
    errorCount: errors.length,
    errors: errors.slice(0, 500),
    preview,
  };
}

// ─── 3. Import Execution ──────────────────────────────────────────────────────

export async function executeImport(buf: Buffer, actor: AuthenticatedUser): Promise<ImportResult> {
  const t0 = Date.now();
  const wb = XLSX.read(buf, { type: 'buffer', raw: false });

  const errors: RowError[] = [];
  const imported: ImportResult['imported'] = {
    categories: 0,
    suppliers: 0,
    locations: 0,
    products: 0,
    serializedItems: 0,
    sales: 0,
    emiSales: 0,
    rentals: 0,
    purchaseOrders: 0,
    stockMovements: 0,
  };
  let skipped = 0;

  const actorId = new Types.ObjectId(actor.id);
  const movements: any[] = [];

  const readSheet = (name: string): Record<string, string>[] => {
    const ws = findSheet(wb, name);
    return ws ? sheetToRows(ws, name).rows : [];
  };

  // ── Reference maps ──
  const catMap = new Map<string, Types.ObjectId>();       // lowercase name → _id
  const supplierMap = new Map<string, Types.ObjectId>();  // lowercase name → _id
  const locMap = new Map<string, Types.ObjectId>();       // uppercase code or lowercase name → _id
  const prodMap = new Map<string, Types.ObjectId>();      // uppercase sku → _id
  const prodNameMap = new Map<string, Types.ObjectId>();  // lowercase name → _id
  const prodCostMap = new Map<string, number>();          // uppercase sku → cost
  const prodPriceMap = new Map<string, number>();         // uppercase sku → price
  const assetMap = new Map<string, Types.ObjectId>();     // uppercase assetId → _id

  // Pre-load existing records from database (if connected)
  if (mongoose.connection.readyState === 1) {
    try {
      (await Category.find().lean()).forEach((c: any) => catMap.set(c.name.trim().toLowerCase(), c._id));
      (await Supplier.find().lean() as any[]).forEach((s: any) => supplierMap.set(s.name.trim().toLowerCase(), s._id));
      (await StockLocation.find().lean()).forEach((l: any) => {
        locMap.set(l.code.trim().toUpperCase(), l._id);
        locMap.set(l.name.trim().toLowerCase(), l._id);
      });
      (await Product.find().lean()).forEach((p: any) => {
        const sku = p.sku.trim().toUpperCase();
        prodMap.set(sku, p._id);
        prodNameMap.set(p.name.trim().toLowerCase(), p._id);
        prodCostMap.set(sku, p.purchaseCost || 0);
        prodPriceMap.set(sku, p.defaultSellingPrice || 0);
      });
      (await SerializedItem.find().lean()).forEach((a: any) => assetMap.set(a.assetId.trim().toUpperCase(), a._id));
    } catch {
      // Gracefully continue
    }
  }

  // Location resolvers & default fallback
  const resolveLocation = (val: string): Types.ObjectId | undefined => {
    if (!val) return locMap.values().next().value;
    return locMap.get(val.trim().toUpperCase()) ?? locMap.get(val.trim().toLowerCase());
  };

  const defaultLoc = async (): Promise<Types.ObjectId> => {
    const first = locMap.values().next().value;
    if (first) return first;

    const mainLoc = await StockLocation.create({
      name: 'Main Store',
      code: 'MAIN',
      type: 'STORE',
      isDefault: true,
      isActive: true,
    });
    const id = mainLoc._id as Types.ObjectId;
    locMap.set('MAIN', id);
    locMap.set('main store', id);
    imported.locations++;
    return id;
  };

  // Helper to resolve product ObjectId by SKU or by Product Name
  const resolveProduct = (ref: string): Types.ObjectId | undefined => {
    if (!ref) return undefined;
    const clean = ref.trim();
    return prodMap.get(clean.toUpperCase()) ?? prodNameMap.get(clean.toLowerCase());
  };

  // ── Step 1: Categories ──
  for (const r of readSheet('Categories')) {
    if (!r['name']?.trim()) {
      skipped++;
      continue;
    }
    const key = r['name'].trim().toLowerCase();
    if (catMap.has(key)) continue;

    try {
      const doc = await Category.create({
        name: r['name'].trim(),
        description: r['description'] || undefined,
      });
      catMap.set(key, doc._id as Types.ObjectId);
      imported.categories++;
    } catch (err: any) {
      if (err.code === 11000) {
        const ex = await Category.findOne({ name: new RegExp(`^${r['name'].trim()}$`, 'i') }).lean();
        if (ex) catMap.set(key, (ex as any)._id);
      } else {
        errors.push({ sheet: 'Categories', row: -1, field: 'Category Name', message: err.message });
      }
    }
  }

  // ── Step 2: Suppliers ──
  for (const r of readSheet('Suppliers')) {
    if (!r['name']?.trim()) {
      skipped++;
      continue;
    }
    const key = r['name'].trim().toLowerCase();
    if (supplierMap.has(key)) continue;

    try {
      const doc = await (Supplier as any).create({
        name: r['name'].trim(),
        contactPerson: r['contactPerson'] || undefined,
        email: r['email'] ? r['email'].toLowerCase() : undefined,
        phone: r['phone'] || undefined,
        address: r['address'] || undefined,
        notes: r['notes'] || undefined,
      });
      supplierMap.set(key, doc._id);
      imported.suppliers++;
    } catch (err: any) {
      if (err.code !== 11000) {
        errors.push({ sheet: 'Suppliers', row: -1, field: 'Supplier Name', message: err.message });
      }
    }
  }

  // ── Step 3: Locations ──
  for (const r of readSheet('Locations')) {
    if (!r['name']?.trim() || !r['code']?.trim()) {
      skipped++;
      continue;
    }
    const code = r['code'].trim().toUpperCase();
    if (locMap.has(code)) continue;

    try {
      const doc = await (StockLocation as any).create({
        name: r['name'].trim(),
        code,
        type: r['type'] || 'STORE',
        address: r['address'] || undefined,
        isDefault: parseBool(r['isDefault']),
        isActive: true,
      });
      locMap.set(code, doc._id);
      locMap.set(r['name'].trim().toLowerCase(), doc._id);
      imported.locations++;
    } catch (err: any) {
      if (err.code !== 11000) {
        errors.push({ sheet: 'Locations', row: -1, field: 'Short Code', message: err.message });
      }
    }
  }

  // Ensure at least one default location exists
  const defLocationId = await defaultLoc();

  // ── Step 4: Products ──
  let maxSkuNum = 0;
  for (const [sku] of prodMap) {
    const m = sku.match(/(\d+)$/);
    if (m) maxSkuNum = Math.max(maxSkuNum, parseInt(m[1], 10));
  }

  for (const r of readSheet('Products')) {
    if (!r['name']?.trim()) {
      skipped++;
      continue;
    }

    let sku = r['sku'] ? r['sku'].trim().toUpperCase() : '';
    if (!sku || sku === 'AUTO') {
      maxSkuNum++;
      sku = `SKU-${String(maxSkuNum).padStart(4, '0')}`;
    }

    if (prodMap.has(sku)) continue;

    // Resolve or auto-create Category
    const catName = (r['category'] || 'General').trim();
    let catId = catMap.get(catName.toLowerCase());
    if (!catId) {
      try {
        const newCat = await Category.create({ name: catName, description: 'Auto-created from product import' });
        catId = newCat._id as Types.ObjectId;
        catMap.set(catName.toLowerCase(), catId);
        imported.categories++;
      } catch {
        const ex = await Category.findOne({ name: new RegExp(`^${catName}$`, 'i') }).lean();
        if (ex) catId = (ex as any)._id;
      }
    }
    if (!catId) catId = catMap.values().next().value;

    // Resolve or auto-create Supplier
    const suppName = r['supplier'] ? r['supplier'].trim() : '';
    let suppId = suppName ? supplierMap.get(suppName.toLowerCase()) : undefined;
    if (suppName && !suppId) {
      try {
        const newSupp = await (Supplier as any).create({ name: suppName, notes: 'Auto-created from product import' });
        suppId = newSupp._id as Types.ObjectId;
        supplierMap.set(suppName.toLowerCase(), suppId);
        imported.suppliers++;
      } catch {
        // Ignore duplicate
      }
    }

    const locId = resolveLocation(r['location'] ?? '') ?? defLocationId;
    const tracking = normalizeTrackingMode(r['trackingMode'] ?? '');
    const opening = parseNum(r['openingStock'], 0);
    const cost = parseNum(r['purchaseCost'], 0);
    const price = parseNum(r['sellingPrice'] ?? r['defaultSellingPrice'], cost);

    try {
      const prod = await Product.create({
        name: r['name'].trim(),
        sku,
        color: r['color'] || undefined,
        hsnCode: r['hsnCode'] || '9202',
        category: catId,
        brand: r['brand']?.trim() || 'Stereobliss',
        modelName: r['modelName'] || undefined,
        description: r['description'] || undefined,
        trackingMode: tracking,
        unitOfMeasure: r['unitOfMeasure'] || 'pcs',
        purchaseCost: cost,
        defaultSellingPrice: price,
        supplier: suppId ?? undefined,
        minStockThreshold: parseNum(r['minStockThreshold'], 5),
        stockQuantity: {
          onHand: tracking === TRACKING_MODES.QUANTITY ? opening : 0,
          reserved: 0,
          issuedInternal: 0,
          quarantined: 0,
        },
        locationStock:
          locId && tracking === TRACKING_MODES.QUANTITY && opening > 0
            ? [{ location: locId, onHand: opening, reserved: 0, issuedInternal: 0, quarantined: 0 }]
            : locId
              ? [{ location: locId, onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 }]
              : [],
        isActive: true,
      });

      prodMap.set(sku, prod._id as Types.ObjectId);
      prodNameMap.set(r['name'].trim().toLowerCase(), prod._id as Types.ObjectId);
      prodCostMap.set(sku, cost);
      prodPriceMap.set(sku, price);
      imported.products++;

      if (tracking === TRACKING_MODES.QUANTITY && opening > 0 && locId) {
        movements.push({
          product: prod._id,
          location: locId,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: opening,
          transactionRef: `HIST-IMPORT-${sku}`,
          transactionModel: 'HistoricalImport',
          reason: `Historical opening stock for ${r['name']}`,
          performedBy: actorId,
        });
        imported.stockMovements++;
      }
    } catch (err: any) {
      if (err.code === 11000) {
        const ex = await Product.findOne({ sku }).lean();
        if (ex) {
          prodMap.set(sku, (ex as any)._id);
          prodNameMap.set(r['name'].trim().toLowerCase(), (ex as any)._id);
        }
      } else {
        errors.push({ sheet: 'Products', row: -1, field: 'SKU Code', message: `${sku}: ${err.message}` });
      }
    }
  }

  // ── Step 5: SerializedItems ──
  for (const r of readSheet('SerializedItems')) {
    if (!r['assetId']?.trim() || !r['productSku']?.trim()) {
      skipped++;
      continue;
    }
    const assetId = r['assetId'].trim().toUpperCase();
    if (assetMap.has(assetId)) {
      skipped++;
      continue;
    }

    const prodId = resolveProduct(r['productSku']);
    const locId = resolveLocation(r['location'] ?? '') ?? defLocationId;
    if (!prodId) {
      skipped++;
      continue;
    }

    const skuKey = r['productSku'].trim().toUpperCase();
    const fallbackCost = prodCostMap.get(skuKey) || 0;
    const unitCost = parseNum(r['unitCost'], fallbackCost);

    const status = normalizeSerializedStatus(r['status'] ?? '');
    const condition = normalizeCondition(r['condition'] ?? '');

    try {
      const item = await SerializedItem.create({
        assetId,
        manufacturerSerial: r['manufacturerSerial'] ? r['manufacturerSerial'].trim().toUpperCase() : undefined,
        product: prodId,
        unitCost,
        location: locId,
        status: status as any,
        condition: condition as any,
        warrantyExpiry: parseDate(r['warrantyExpiry']) ?? undefined,
        notes: r['notes'] || undefined,
      });

      assetMap.set(assetId, item._id as Types.ObjectId);
      imported.serializedItems++;

      if (status === SERIALIZED_STATUSES.AVAILABLE) {
        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': 1 } });
        const prod = await Product.findById(prodId);
        if (prod) {
          const hasLoc = prod.locationStock.some(ls => ls.location.toString() === locId.toString());
          if (!hasLoc) {
            prod.locationStock.push({ location: locId, onHand: 1, reserved: 0, issuedInternal: 0, quarantined: 0 });
          } else {
            const ls = prod.locationStock.find(l => l.location.toString() === locId.toString());
            if (ls) ls.onHand += 1;
          }
          await prod.save();
        }

        movements.push({
          product: prodId,
          serializedItem: item._id,
          location: locId,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: 0,
          destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
          transactionRef: `HIST-ASSET-${assetId}`,
          transactionModel: 'HistoricalImport',
          reason: `Historical serialized item ${assetId} imported`,
          performedBy: actorId,
        });
        imported.stockMovements++;
      }
    } catch (err: any) {
      if (err.code !== 11000) {
        errors.push({ sheet: 'SerializedItems', row: -1, field: 'Asset ID', message: `${assetId}: ${err.message}` });
      }
    }
  }

  // ── Step 6: Direct Sales ──
  {
    const rows = readSheet('DirectSales');
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['invoiceNumber']?.trim()) continue;
      const inv = r['invoiceNumber'].trim().toUpperCase();
      if (!groups.has(inv)) groups.set(inv, []);
      groups.get(inv)!.push(r);
    }

    for (const [invoiceNumber, lines] of groups) {
      if (await Sale.exists({ invoiceNumber })) {
        skipped++;
        continue;
      }

      const first = lines[0];
      const saleDate = parseDate(first['date']) ?? new Date();
      const locId = defLocationId;

      const lineItems: any[] = [];
      let subtotal = 0, discountTotal = 0;

      for (const line of lines) {
        const prodRef = line['productSku'] ?? '';
        const prodId = resolveProduct(prodRef);
        if (!prodId) continue;

        const skuKey = prodRef.trim().toUpperCase();
        const fallbackPrice = prodPriceMap.get(skuKey) || 0;

        const qty = Math.max(1, parseNum(line['quantity'], 1));
        const price = parseNum(line['unitPrice'], fallbackPrice);
        const disc = parseNum(line['discount'], 0);
        const net = Math.max(0, (price - disc) * qty);

        subtotal += price * qty;
        discountTotal += disc * qty;

        const serializedIds: Types.ObjectId[] = [];
        if (line['assetId']) {
          const aid = assetMap.get(line['assetId'].trim().toUpperCase());
          if (aid) {
            serializedIds.push(aid);
            await SerializedItem.findByIdAndUpdate(aid, { status: SERIALIZED_STATUSES.SOLD });
          }
        }

        lineItems.push({
          product: prodId,
          quantity: qty,
          unitPrice: price,
          discount: disc,
          hsnCode: line['hsnCode'] || '9202',
          taxableAmount: net,
          cgstAmount: Math.round(net * 0.09 * 100) / 100,
          sgstAmount: Math.round(net * 0.09 * 100) / 100,
          total: net,
          serializedItemIds: serializedIds,
        });

        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': -qty } });

        movements.push({
          product: prodId,
          serializedItem: serializedIds[0],
          location: locId,
          movementType: MOVEMENT_TYPES.SALE,
          quantityDelta: -qty,
          transactionRef: invoiceNumber,
          transactionModel: 'Sale',
          reason: `Historical sale ${invoiceNumber}`,
          performedBy: actorId,
        });
        imported.stockMovements++;
      }

      if (!lineItems.length) {
        skipped++;
        continue;
      }

      const taxable = Math.max(0, subtotal - discountTotal);
      const cgst = Math.round(taxable * 0.09 * 100) / 100;
      const sgst = cgst;
      const grand = Math.round((taxable + cgst + sgst) * 100) / 100;

      const pmStatus = normalizePaymentStatus(first['paymentStatus'] ?? '');
      const pmMethod = normalizePaymentMethod(first['paymentMethod'] ?? '');

      // Resilient fallbacks for customer email and phone
      const custEmail = first['customerEmail']?.trim()
        ? first['customerEmail'].trim().toLowerCase()
        : `customer-${invoiceNumber.toLowerCase()}@retail.local`;
      const custPhone = first['customerPhone']?.trim() || '0000000000';

      try {
        await Sale.create({
          invoiceNumber,
          customerName: first['customerName'].trim(),
          customerEmail: custEmail,
          customerPhone: custPhone,
          customerGstin: first['customerGstin'] || undefined,
          customerAddress: first['customerAddress'] || undefined,
          dispatchThrough: first['dispatchThrough'] || undefined,
          destination: first['destination'] || undefined,
          eWayBillNo: first['eWayBillNo'] || undefined,
          location: locId,
          lineItems,
          subtotal,
          discountTotal,
          taxableAmount: taxable,
          cgstRate: 9,
          cgstAmount: cgst,
          sgstRate: 9,
          sgstAmount: sgst,
          taxTotal: cgst + sgst,
          grandTotal: grand,
          paymentStatus: pmStatus as any,
          paymentMethod: pmMethod as any,
          saleStatus: SALE_STATUSES.CONFIRMED,
          saleType: SALE_TYPES.DIRECT,
          isEmi: false,
          soldBy: actorId,
          confirmedAt: saleDate,
          notes: first['notes'] || undefined,
          idempotencyKey: `HIST-${invoiceNumber}`,
          createdAt: saleDate,
        });
        imported.sales++;
      } catch (err: any) {
        if (err.code !== 11000) {
          errors.push({ sheet: 'DirectSales', row: -1, field: 'Invoice No.', message: `${invoiceNumber}: ${err.message}` });
        } else {
          skipped++;
        }
      }
    }
  }

  // ── Step 7 & 8: EMI Sales + Payments ──
  const emiPayRows = readSheet('EMIPayments');
  {
    const rows = readSheet('EMISales');
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['invoiceNumber']?.trim()) continue;
      const inv = r['invoiceNumber'].trim().toUpperCase();
      if (!groups.has(inv)) groups.set(inv, []);
      groups.get(inv)!.push(r);
    }

    for (const [invoiceNumber, lines] of groups) {
      if (await Sale.exists({ invoiceNumber })) {
        skipped++;
        continue;
      }

      const first = lines[0];
      const saleDate = parseDate(first['date']) ?? new Date();
      const locId = defLocationId;
      const tenure = Math.max(1, parseNum(first['emiTenureMonths'], 6));
      const downPay = parseNum(first['downPayment'], 0);

      const lineItems: any[] = [];
      let subtotal = 0, discountTotal = 0;

      for (const line of lines) {
        const prodRef = line['productSku'] ?? '';
        const prodId = resolveProduct(prodRef);
        if (!prodId) continue;

        const skuKey = prodRef.trim().toUpperCase();
        const fallbackPrice = prodPriceMap.get(skuKey) || 0;

        const qty = Math.max(1, parseNum(line['quantity'], 1));
        const price = parseNum(line['unitPrice'], fallbackPrice);
        const disc = parseNum(line['discount'], 0);
        const net = Math.max(0, (price - disc) * qty);

        subtotal += price * qty;
        discountTotal += disc * qty;

        const serializedIds: Types.ObjectId[] = [];
        if (line['assetId']) {
          const aid = assetMap.get(line['assetId'].trim().toUpperCase());
          if (aid) {
            serializedIds.push(aid);
            await SerializedItem.findByIdAndUpdate(aid, { status: SERIALIZED_STATUSES.SOLD });
          }
        }

        lineItems.push({
          product: prodId,
          quantity: qty,
          unitPrice: price,
          discount: disc,
          hsnCode: line['hsnCode'] || '9202',
          taxableAmount: net,
          cgstAmount: Math.round(net * 0.09 * 100) / 100,
          sgstAmount: Math.round(net * 0.09 * 100) / 100,
          total: net,
          serializedItemIds: serializedIds,
        });

        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': -qty } });

        movements.push({
          product: prodId,
          serializedItem: serializedIds[0],
          location: locId,
          movementType: MOVEMENT_TYPES.SALE,
          quantityDelta: -qty,
          transactionRef: invoiceNumber,
          transactionModel: 'Sale',
          reason: `Historical EMI sale ${invoiceNumber}`,
          performedBy: actorId,
        });
        imported.stockMovements++;
      }

      if (!lineItems.length) {
        skipped++;
        continue;
      }

      const taxable = Math.max(0, subtotal - discountTotal);
      const cgst = Math.round(taxable * 0.09 * 100) / 100;
      const sgst = cgst;
      const grand = Math.round((taxable + cgst + sgst) * 100) / 100;
      const financed = Math.max(0, grand - downPay);
      const monthly = tenure > 0 ? Math.round(financed / tenure) : 0;

      // Build EMI schedule
      const schedRows = emiPayRows.filter(r => (r['invoiceNumber'] ?? '').trim().toUpperCase() === invoiceNumber);
      let emiPayments: any[] = [], emiPaid = downPay, emiDue = 0;

      if (schedRows.length > 0) {
        emiPayments = schedRows.map(p => {
          const due = parseNum(p['amountDue'], monthly);
          const paid = parseNum(p['amountPaid'], 0);
          emiPaid += paid;
          emiDue += Math.max(0, due - paid);
          const mIdx = Math.max(1, parseNum(p['monthIndex'], 1));
          return {
            monthIndex: mIdx,
            billingMonth: p['billingMonth'] || `Month ${mIdx}`,
            dueDate: parseDate(p['dueDate']) ?? saleDate,
            amountDue: due,
            amountPaid: paid,
            paidAt: parseDate(p['paidDate']) ?? undefined,
            paymentMethod: p['paymentMethod'] ? normalizePaymentMethod(p['paymentMethod']) : undefined,
            transactionRef: p['transactionRef'] || undefined,
            status: (['PAID', 'DUE', 'OVERDUE'].includes((p['status'] || '').toUpperCase())
              ? (p['status'] || '').toUpperCase()
              : paid >= due
                ? 'PAID'
                : 'DUE') as any,
            notes: p['notes'] || undefined,
          };
        });
      } else {
        for (let m = 1; m <= tenure; m++) {
          const d = new Date(saleDate);
          d.setMonth(d.getMonth() + m);
          emiPayments.push({
            monthIndex: m,
            billingMonth: `Month ${m}`,
            dueDate: d,
            amountDue: monthly,
            amountPaid: 0,
            status: 'DUE',
          });
          emiDue += monthly;
        }
      }

      const pmStatus = emiDue <= 0 ? PAYMENT_STATUSES.PAID : emiPaid > 0 ? PAYMENT_STATUSES.PARTIAL : PAYMENT_STATUSES.PENDING;
      const custEmail = first['customerEmail']?.trim()
        ? first['customerEmail'].trim().toLowerCase()
        : `customer-${invoiceNumber.toLowerCase()}@retail.local`;
      const custPhone = first['customerPhone']?.trim() || '0000000000';

      try {
        await Sale.create({
          invoiceNumber,
          customerName: first['customerName'].trim(),
          customerEmail: custEmail,
          customerPhone: custPhone,
          customerGstin: first['customerGstin'] || undefined,
          customerAddress: first['customerAddress'] || undefined,
          location: locId,
          lineItems,
          subtotal,
          discountTotal,
          taxableAmount: taxable,
          cgstRate: 9,
          cgstAmount: cgst,
          sgstRate: 9,
          sgstAmount: sgst,
          taxTotal: cgst + sgst,
          grandTotal: grand,
          paymentStatus: pmStatus as any,
          paymentMethod: normalizePaymentMethod(first['downPaymentMethod'] ?? 'UPI') as any,
          saleStatus: SALE_STATUSES.CONFIRMED,
          saleType: SALE_TYPES.EMI,
          isEmi: true,
          downPayment: downPay,
          emiTenureMonths: tenure,
          monthlyEmiAmount: monthly,
          totalEmiPaid: emiPaid,
          totalEmiDue: emiDue,
          emiPayments,
          paymentLogs:
            downPay > 0
              ? [
                {
                  paymentType: 'DOWN_PAYMENT',
                  amount: downPay,
                  paymentMethod: PAYMENT_METHODS.UPI,
                  transactionRef: `HIST-DP-${invoiceNumber}`,
                  billingMonth: 'Down Payment',
                  notes: 'Historical import',
                  recordedBy: actorId,
                  paidAt: saleDate,
                },
              ]
              : [],
          soldBy: actorId,
          confirmedAt: saleDate,
          notes: first['notes'] || undefined,
          idempotencyKey: `HIST-${invoiceNumber}`,
          createdAt: saleDate,
        });
        imported.emiSales++;
      } catch (err: any) {
        if (err.code !== 11000) {
          errors.push({ sheet: 'EMISales', row: -1, field: 'Invoice No.', message: `${invoiceNumber}: ${err.message}` });
        } else {
          skipped++;
        }
      }
    }
  }

  // ── Step 9 & 10: Rentals + RentalPayments ──
  const rentalPayRows = readSheet('RentalPayments');
  for (const r of readSheet('Rentals')) {
    if (!r['issueReference']?.trim() || !r['productSku']?.trim()) {
      skipped++;
      continue;
    }

    const ref = r['issueReference'].trim().toUpperCase();
    if (await InternalUsage.exists({ issueReference: ref })) {
      skipped++;
      continue;
    }

    const prodId = resolveProduct(r['productSku']);
    if (!prodId) {
      skipped++;
      continue;
    }

    const locId = defLocationId;
    const issueDate = parseDate(r['issueDate']) ?? new Date();
    const expReturn = parseDate(r['expectedReturnDate']) ?? new Date();
    const actReturn = parseDate(r['actualReturnDate']);
    const status = normalizeRentalStatus(r['status'] ?? '');
    const purpose = normalizeRentalPurpose(r['purpose'] ?? '');
    const serialId = r['assetId'] ? assetMap.get(r['assetId'].trim().toUpperCase()) : undefined;
    const qty = Math.max(1, parseNum(r['quantityIssued'], 1));
    const monthly = parseNum(r['monthlyRent'], 0);
    const deposit = parseNum(r['securityDeposit'], 0);
    const lockIn = Math.max(1, parseNum(r['lockInPeriodMonths'], 3));
    const depMode = parseBool(r['depositMode']);
    const accessories = r['includedAccessories']
      ? r['includedAccessories'].split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const schedRows = rentalPayRows.filter(p => (p['issueReference'] ?? '').trim().toUpperCase() === ref);
    let monthlyPayments: any[] = [], totalPaid = 0, totalDue = 0;
    const paymentLogs: any[] = [];

    if (deposit > 0) {
      paymentLogs.push({
        paymentType: 'SECURITY_DEPOSIT',
        amount: deposit,
        paymentMethod: 'CASH',
        transactionRef: r['depositTransactionRef'] || `HIST-DEP-${ref}`,
        billingMonth: 'Security Deposit',
        notes: 'Historical import',
        recordedBy: actorId,
        paidAt: issueDate,
      });
    }

    if (schedRows.length > 0) {
      monthlyPayments = schedRows.map(p => {
        const due = parseNum(p['amountDue'], monthly);
        const paid = parseNum(p['amountPaid'], 0);
        totalPaid += paid;
        totalDue += Math.max(0, due - paid);
        const mIdx = Math.max(1, parseNum(p['monthIndex'], 1));

        if (paid > 0) {
          paymentLogs.push({
            paymentType: 'RENTAL_PAYMENT',
            amount: paid,
            paymentMethod: normalizePaymentMethod(p['paymentMethod'] ?? 'CASH'),
            transactionRef: p['transactionRef'] || `HIST-RENT-${ref}-M${mIdx}`,
            billingMonth: p['billingMonth'] || `Month ${mIdx}`,
            notes: 'Historical import',
            recordedBy: actorId,
            paidAt: parseDate(p['paidDate']) ?? issueDate,
          });
        }

        return {
          monthIndex: mIdx,
          billingMonth: p['billingMonth'] || `Month ${mIdx}`,
          dueDate: parseDate(p['dueDate']) ?? issueDate,
          amountDue: due,
          amountPaid: paid,
          paidAt: parseDate(p['paidDate']) ?? undefined,
          paymentMethod: p['paymentMethod'] ? normalizePaymentMethod(p['paymentMethod']) : undefined,
          transactionRef: p['transactionRef'] || undefined,
          status: (['PAID', 'DUE', 'OVERDUE'].includes((p['status'] || '').toUpperCase())
            ? (p['status'] || '').toUpperCase()
            : paid >= due
              ? 'PAID'
              : 'DUE') as any,
          notes: p['notes'] || undefined,
        };
      });
    } else {
      for (let m = 1; m <= lockIn; m++) {
        const d = new Date(issueDate);
        d.setMonth(d.getMonth() + (m - 1));
        monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m}`,
          dueDate: d,
          amountDue: monthly,
          amountPaid: 0,
          status: 'DUE',
        });
        totalDue += monthly;
      }
    }

    try {
      const usage = await InternalUsage.create({
        issueReference: ref,
        purpose: purpose as any,
        assignedPerson: (r['assignedPerson'] || r['customerName'] || 'Customer').trim(),
        assignedPersonContact: r['assignedPersonContact'] || r['customerPhone'] || undefined,
        customerEmail: r['customerEmail'] ? r['customerEmail'].toLowerCase().trim() : undefined,
        location: locId,
        items: [
          {
            product: prodId,
            quantityIssued: qty,
            quantityReturned: status === USAGE_STATUSES.RETURNED ? qty : 0,
            serializedItemId: serialId ?? undefined,
            issueCondition: ITEM_CONDITIONS.GOOD,
          },
        ],
        issueDate,
        expectedReturnDate: expReturn,
        actualReturnDate: actReturn ?? undefined,
        status: status as any,
        notes: r['notes'] || undefined,
        issuedBy: actorId,
        isRental: true,
        lockInPeriodMonths: lockIn,
        securityDeposit: deposit,
        depositTransactionRef: r['depositTransactionRef'] || '',
        depositMode: depMode,
        depositBalance: r['depositBalance'] !== undefined && r['depositBalance'] !== ''
          ? parseNum(r['depositBalance'])
          : (depMode ? Math.max(0, deposit - totalPaid) : deposit),
        depositExhausted: depMode
          ? (r['depositBalance'] !== undefined && r['depositBalance'] !== ''
            ? parseNum(r['depositBalance']) <= 0
            : deposit - totalPaid <= 0)
          : false,
        depositRefundStatus: ['HELD', 'REFUND_PENDING', 'REFUNDED'].includes(r['depositRefundStatus']?.trim()?.toUpperCase())
          ? (r['depositRefundStatus'].trim().toUpperCase() as any)
          : (status === USAGE_STATUSES.RETURNED ? 'REFUNDED' : 'HELD'),
        monthlyRent: monthly,
        includedAccessories: accessories,
        monthlyPayments,
        totalRentPaid: totalPaid,
        totalRentDue: totalDue,
        paymentLogs,
        createdAt: issueDate,
      });

      if (serialId && status === USAGE_STATUSES.ACTIVE) {
        await SerializedItem.findByIdAndUpdate(serialId, {
          status: SERIALIZED_STATUSES.ISSUED_INTERNAL,
          currentUsage: usage._id,
          assignedTo: (r['assignedPerson'] || r['customerName'] || 'Customer').trim(),
        });
      } else if (serialId && status === USAGE_STATUSES.RETURNED) {
        await SerializedItem.findByIdAndUpdate(serialId, {
          status: SERIALIZED_STATUSES.AVAILABLE,
          currentUsage: null,
          assignedTo: null,
        });
      }

      if (status === USAGE_STATUSES.ACTIVE) {
        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.issuedInternal': qty } });
      }

      imported.rentals++;

      movements.push({
        product: prodId,
        serializedItem: serialId,
        location: locId,
        movementType: MOVEMENT_TYPES.INTERNAL_ISSUE,
        quantityDelta: 0,
        transactionRef: ref,
        transactionModel: 'InternalUsage',
        reason: `Historical rental ${ref}`,
        performedBy: actorId,
      });
      imported.stockMovements++;
    } catch (err: any) {
      if (err.code !== 11000) {
        errors.push({ sheet: 'Rentals', row: -1, field: 'Reference No.', message: `${ref}: ${err.message}` });
      } else {
        skipped++;
      }
    }
  }

  // ── Step 11: Purchase Orders ──
  {
    const rows = readSheet('PurchaseOrders');
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['poNumber']?.trim()) continue;
      const po = r['poNumber'].trim().toUpperCase();
      if (!groups.has(po)) groups.set(po, []);
      groups.get(po)!.push(r);
    }

    for (const [poNumber, lines] of groups) {
      if (await Purchase.exists({ purchaseOrderNumber: poNumber })) {
        skipped++;
        continue;
      }

      const first = lines[0];
      const orderDate = parseDate(first['orderDate']) ?? new Date();
      const locId = resolveLocation(first['location'] ?? '') ?? defLocationId;

      const suppName = (first['supplier'] || 'General Supplier').trim();
      let suppId = supplierMap.get(suppName.toLowerCase());
      if (!suppId) {
        try {
          const newSupp = await (Supplier as any).create({ name: suppName, notes: 'Auto-created from PO import' });
          suppId = newSupp._id as Types.ObjectId;
          supplierMap.set(suppName.toLowerCase(), suppId);
          imported.suppliers++;
        } catch {
          suppId = supplierMap.values().next().value;
        }
      }

      if (!suppId) {
        skipped++;
        continue;
      }

      const poStatus = normalizePOStatus(first['status'] ?? '');
      const poLines: any[] = [];
      let poSubtotal = 0;

      for (const line of lines) {
        const prodRef = line['productSku'] ?? '';
        const prodId = resolveProduct(prodRef);
        if (!prodId) continue;

        const skuKey = prodRef.trim().toUpperCase();
        const fallbackCost = prodCostMap.get(skuKey) || 0;

        const qtyOrd = Math.max(1, parseNum(line['quantityOrdered'], 1));
        const qtyRec = parseNum(line['quantityReceived'] || line['quantityOrdered'], qtyOrd);
        const cost = parseNum(line['unitCost'], fallbackCost);

        poSubtotal += cost * qtyOrd;
        poLines.push({
          product: prodId,
          quantityOrdered: qtyOrd,
          quantityReceived: qtyRec,
          unitCost: cost,
          totalCost: cost * qtyOrd,
        });

        // Reconcile stock for received quantity
        if (qtyRec > 0) {
          await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': qtyRec } });
          const prod = await Product.findById(prodId);
          if (prod) {
            const ls = prod.locationStock.find(l => l.location.toString() === locId.toString());
            if (ls) {
              ls.onHand += qtyRec;
            } else {
              prod.locationStock.push({ location: locId, onHand: qtyRec, reserved: 0, issuedInternal: 0, quarantined: 0 });
            }
            await prod.save();
          }

          movements.push({
            product: prodId,
            location: locId,
            movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
            quantityDelta: qtyRec,
            transactionRef: poNumber,
            transactionModel: 'Purchase',
            reason: `Historical PO ${poNumber}`,
            performedBy: actorId,
          });
          imported.stockMovements++;
        }
      }

      if (!poLines.length) {
        skipped++;
        continue;
      }

      try {
        const po = await Purchase.create({
          purchaseOrderNumber: poNumber,
          supplier: suppId,
          invoiceReference: first['invoiceReference'] || undefined,
          orderDate,
          lineItems: poLines,
          subtotal: poSubtotal,
          additionalCosts: 0,
          totalCost: poSubtotal,
          status: poStatus as any,
          destinationLocation: locId,
          notes: first['notes'] || undefined,
          createdBy: actorId,
          createdAt: orderDate,
        });

        if (poStatus === PURCHASE_STATUSES.COMPLETED) {
          const receiptCount = await PurchaseReceipt.countDocuments();
          const rcptNum = `RCPT-${new Date(orderDate).getFullYear()}-${String(receiptCount + 1).padStart(5, '0')}`;
          await PurchaseReceipt.create({
            receiptNumber: rcptNum,
            purchase: po._id,
            receivedDate: orderDate,
            lineItems: poLines.map(l => ({ product: l.product, quantityReceived: l.quantityReceived, unitCost: l.unitCost })),
            destinationLocation: locId,
            receivedBy: actorId,
            notes: 'Historical import',
            createdAt: orderDate,
          });
        }

        imported.purchaseOrders++;
      } catch (err: any) {
        if (err.code !== 11000) {
          errors.push({ sheet: 'PurchaseOrders', row: -1, field: 'PO Number', message: `${poNumber}: ${err.message}` });
        } else {
          skipped++;
        }
      }
    }
  }

  // ── Step 12: Write all stock movements in bulk ──
  if (movements.length > 0) {
    try {
      await StockMovement.insertMany(movements, { ordered: false });
    } catch (err: any) {
      if (err.code !== 11000 && err.name !== 'MongoBulkWriteError') {
        errors.push({ sheet: 'System', row: -1, field: 'Stock Movements', message: err.message });
      }
    }
  }

  return {
    success: errors.length === 0,
    durationMs: Date.now() - t0,
    skipped,
    errors: errors.slice(0, 200),
    imported,
  };
}
