/**
 * Historical Data Import Service — Stereobliss Retail
 *
 * Provides three capabilities:
 *   1. generateImportTemplate()  → Buffer (Excel .xlsx)
 *   2. validateImportFile()      → ValidationResult (row-level errors, preview counts)
 *   3. executeImport()           → ImportResult (records created, stock reconciled)
 *
 * Import order (respects FK dependencies):
 *   Categories → Suppliers → Locations → Products → SerializedItems
 *   → DirectSales → EMISales+EMIPayments → Rentals+RentalPayments → PurchaseOrders
 */

import * as XLSX from 'xlsx';
import { Types } from 'mongoose';

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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RowError {
  sheet: string;
  row: number;   // 1-based Excel row (data starts at row 3 because row 1=headers, row 2=notes)
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  totalRows: number;
  validRows: number;
  skippedRows: number;
  errorCount: number;
  errors: RowError[];
  preview: {
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
  };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  // Excel serial number
  const n = Number(s);
  if (!isNaN(n) && n > 1000) {
    const parsed = XLSX.SSF.parse_date_code(n);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseNum(val: unknown, def = 0): number {
  const n = Number(val);
  return isNaN(n) ? def : n;
}

function parseBool(val: unknown): boolean {
  const s = String(val ?? '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES';
}

/** Convert a worksheet to an array of plain objects.
 *  Row 0 = headers (stripped of " *"), Row 1 = notes (skipped), Row 2+ = data. */
function sheetToRows(ws: XLSX.WorkSheet): Record<string, string>[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
  if (!aoa || aoa.length < 3) return [];

  const rawHeaders = aoa[0] as string[];
  // Normalise: strip " *" suffix and trim
  const headers = rawHeaders.map(h => String(h ?? '').replace(' *', '').trim());
  const dataRows = aoa.slice(2); // skip header row + notes row

  return dataRows
    .map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = String((row as unknown[])[i] ?? '').trim();
      });
      return obj;
    })
    .filter(r => Object.values(r).some(v => v !== ''));
}

// ─── Column definitions for the template ─────────────────────────────────────

interface ColDef { header: string; key: string; width: number; required?: boolean; hint?: string; example?: string | number }

// Simplified column sets — plain English, only essential columns, with examples
const SHEET_COLS: Record<string, ColDef[]> = {
  Categories: [
    { header: 'Category Name',  key: 'name',        width: 28, required: true,  example: 'Guitars' },
    { header: 'Description',    key: 'description', width: 44, required: false, example: 'Acoustic and electric guitars' },
  ],
  Suppliers: [
    { header: 'Supplier Name',  key: 'name',          width: 30, required: true,  example: 'Furtados Music' },
    { header: 'Contact Person', key: 'contactPerson', width: 25, required: false, example: 'Raj Kumar' },
    { header: 'Email',          key: 'email',         width: 30, required: false, example: 'raj@furtados.com' },
    { header: 'Phone',          key: 'phone',         width: 18, required: false, example: '9820012345' },
  ],
  Locations: [
    { header: 'Location Name',  key: 'name',      width: 28, required: true,  example: 'Main Store' },
    { header: 'Short Code',     key: 'code',      width: 14, required: true,  hint: 'e.g. MAIN',      example: 'MAIN' },
    { header: 'Is Default?',    key: 'isDefault', width: 14, required: false, hint: 'TRUE or FALSE',   example: 'TRUE' },
  ],
  Products: [
    { header: 'Product Name',    key: 'name',             width: 32, required: true,  example: 'Yamaha F310 Acoustic Guitar' },
    { header: 'SKU Code',        key: 'sku',              width: 16, required: false, hint: 'Leave blank to auto-generate', example: 'SKU-0001' },
    { header: 'Category',        key: 'category',         width: 22, required: true,  hint: 'Must match Category Name', example: 'Guitars' },
    { header: 'Brand',           key: 'brand',            width: 20, required: false, example: 'Yamaha' },
    { header: 'Color / Finish',  key: 'color',            width: 18, required: false, example: 'Natural' },
    { header: 'Tracking Mode',   key: 'trackingMode',     width: 18, required: false, hint: 'QUANTITY or SERIALIZED', example: 'SERIALIZED' },
    { header: 'Purchase Cost',   key: 'purchaseCost',     width: 16, required: true,  hint: 'Number only, no symbol',  example: 6000 },
    { header: 'Selling Price',   key: 'sellingPrice',     width: 16, required: true,  hint: 'Number only, no symbol',  example: 8500 },
    { header: 'Opening Stock',   key: 'openingStock',     width: 16, required: false, hint: 'For QUANTITY mode only',  example: 4 },
    { header: 'Location Code',   key: 'location',         width: 18, required: false, hint: 'Where stock lives',       example: 'MAIN' },
    { header: 'Supplier',        key: 'supplier',         width: 24, required: false, hint: 'Must match Supplier Name', example: 'Furtados Music' },
  ],
  SerializedItems: [
    { header: 'Asset ID',         key: 'assetId',           width: 20, required: true,  hint: 'Unique tag e.g. F310-001', example: 'F310-001' },
    { header: 'Product SKU',      key: 'productSku',        width: 18, required: true,  hint: 'Must match SKU Code',      example: 'SKU-0001' },
    { header: 'Mfr Serial No.',   key: 'manufacturerSerial',width: 22, required: false, example: 'YMH123456' },
    { header: 'Purchase Cost',    key: 'unitCost',          width: 14, required: true,  example: 6000 },
    { header: 'Location',         key: 'location',          width: 18, required: true,  example: 'MAIN' },
    { header: 'Status',           key: 'status',            width: 18, required: false, hint: 'AVAILABLE or SOLD',        example: 'AVAILABLE' },
    { header: 'Condition',        key: 'condition',         width: 14, required: false, hint: 'NEW / GOOD / FAIR / POOR', example: 'NEW' },
    { header: 'Warranty Expiry',  key: 'warrantyExpiry',    width: 18, required: false, hint: 'YYYY-MM-DD',               example: '2026-12-31' },
  ],
  DirectSales: [
    { header: 'Invoice No.',     key: 'invoiceNumber',  width: 20, required: true,  hint: 'Same No. for multi-item sale', example: 'INV-2024-0001' },
    { header: 'Sale Date',       key: 'date',           width: 14, required: true,  hint: 'YYYY-MM-DD',                  example: '2024-01-15' },
    { header: 'Customer Name',   key: 'customerName',   width: 26, required: true,  example: 'Rahul Sharma' },
    { header: 'Customer Email',  key: 'customerEmail',  width: 30, required: true,  example: 'rahul@gmail.com' },
    { header: 'Customer Phone',  key: 'customerPhone',  width: 16, required: true,  example: '9876543210' },
    { header: 'Product SKU',     key: 'productSku',     width: 18, required: true,  example: 'SKU-0001' },
    { header: 'Qty',             key: 'quantity',       width: 8,  required: true,  example: 1 },
    { header: 'Unit Price',      key: 'unitPrice',      width: 14, required: true,  hint: 'Number only',                 example: 8500 },
    { header: 'Discount',        key: 'discount',       width: 12, required: false, hint: 'Per-unit discount, default 0', example: 0 },
    { header: 'Asset ID',        key: 'assetId',        width: 16, required: false, hint: 'For serialized products',     example: 'F310-001' },
    { header: 'Payment Method',  key: 'paymentMethod',  width: 18, required: true,  hint: 'CASH / UPI / CARD / BANK_TRANSFER', example: 'UPI' },
  ],
  EMISales: [
    { header: 'Invoice No.',      key: 'invoiceNumber',    width: 20, required: true,  hint: 'Same No. for multi-item sale',    example: 'INV-2024-0010' },
    { header: 'Sale Date',        key: 'date',             width: 14, required: true,  hint: 'YYYY-MM-DD',                     example: '2024-02-01' },
    { header: 'Customer Name',    key: 'customerName',     width: 26, required: true,  example: 'Priya Desai' },
    { header: 'Customer Email',   key: 'customerEmail',    width: 30, required: true,  example: 'priya@gmail.com' },
    { header: 'Customer Phone',   key: 'customerPhone',    width: 16, required: true,  example: '9988776655' },
    { header: 'Product SKU',      key: 'productSku',       width: 18, required: true,  example: 'SKU-0002' },
    { header: 'Qty',              key: 'quantity',         width: 8,  required: true,  example: 1 },
    { header: 'Unit Price',       key: 'unitPrice',        width: 14, required: true,  example: 7200 },
    { header: 'Down Payment',     key: 'downPayment',      width: 16, required: true,  hint: 'Amount paid upfront',             example: 1200 },
    { header: 'No. of Months',    key: 'emiTenureMonths',  width: 16, required: true,  hint: 'Total EMI instalments',           example: 6 },
  ],
  EMIPayments: [
    { header: 'Invoice No.',     key: 'invoiceNumber', width: 20, required: true,  hint: 'Must match EMI Sales Invoice No.',  example: 'INV-2024-0010' },
    { header: 'Month No.',       key: 'monthIndex',    width: 12, required: true,  hint: '1 for first instalment',            example: 1 },
    { header: 'Month Label',     key: 'billingMonth',  width: 24, required: true,  hint: 'e.g. Month 1 (Jan 2024)',           example: 'Month 1 (Mar 2024)' },
    { header: 'Due Date',        key: 'dueDate',       width: 14, required: true,  hint: 'YYYY-MM-DD',                       example: '2024-03-01' },
    { header: 'Amount Due',      key: 'amountDue',     width: 14, required: true,  example: 1000 },
    { header: 'Amount Paid',     key: 'amountPaid',    width: 14, required: false, hint: '0 if unpaid',                      example: 1000 },
    { header: 'Date Paid',       key: 'paidDate',      width: 14, required: false, hint: 'YYYY-MM-DD, blank if unpaid',      example: '2024-03-05' },
    { header: 'Payment Method',  key: 'paymentMethod', width: 18, required: false, example: 'UPI' },
    { header: 'Transaction Ref', key: 'transactionRef',width: 26, required: false, example: 'UPI-998001' },
    { header: 'Status',          key: 'status',        width: 12, required: true,  hint: 'PAID / DUE / OVERDUE',             example: 'PAID' },
  ],
  Rentals: [
    { header: 'Reference No.',       key: 'issueReference',       width: 22, required: true,  hint: 'e.g. USE-2024-00001',          example: 'USE-2024-00001' },
    { header: 'Issue Date',          key: 'issueDate',            width: 14, required: true,  hint: 'YYYY-MM-DD',                   example: '2024-03-01' },
    { header: 'Return By Date',      key: 'expectedReturnDate',   width: 18, required: true,  hint: 'YYYY-MM-DD',                   example: '2024-06-01' },
    { header: 'Customer Name',       key: 'assignedPerson',       width: 26, required: true,  example: 'Amit Joshi' },
    { header: 'Customer Phone',      key: 'assignedPersonContact',width: 18, required: false, example: '9123456780' },
    { header: 'Customer Email',      key: 'customerEmail',        width: 30, required: false, example: 'amit@gmail.com' },
    { header: 'Product SKU',         key: 'productSku',           width: 18, required: true,  example: 'SKU-0001' },
    { header: 'Asset ID',            key: 'assetId',              width: 16, required: false, example: 'F310-001' },
    { header: 'Monthly Rent',        key: 'monthlyRent',          width: 14, required: true,  hint: 'Number only',                  example: 1500 },
    { header: 'Security Deposit',    key: 'securityDeposit',      width: 18, required: false, hint: 'Number only, 0 if none',       example: 5000 },
    { header: 'Deposit Txn Ref',     key: 'depositTransactionRef',width: 20, required: false, example: 'CASH-001' },
    { header: 'Status',              key: 'status',               width: 20, required: false, hint: 'ACTIVE / RETURNED / OVERDUE',  example: 'ACTIVE' },
    { header: 'Accessories',         key: 'includedAccessories',  width: 36, required: false, hint: 'Comma-separated',              example: 'Stand, Power Adapter' },
  ],
  RentalPayments: [
    { header: 'Reference No.',   key: 'issueReference', width: 22, required: true,  hint: 'Must match Rental Reference No.', example: 'USE-2024-00001' },
    { header: 'Month No.',       key: 'monthIndex',     width: 12, required: true,  example: 1 },
    { header: 'Month Label',     key: 'billingMonth',   width: 24, required: true,  example: 'Month 1 (Mar 2024)' },
    { header: 'Due Date',        key: 'dueDate',        width: 14, required: true,  hint: 'YYYY-MM-DD', example: '2024-03-01' },
    { header: 'Amount Due',      key: 'amountDue',      width: 14, required: true,  example: 1500 },
    { header: 'Amount Paid',     key: 'amountPaid',     width: 14, required: false, example: 1500 },
    { header: 'Date Paid',       key: 'paidDate',       width: 14, required: false, hint: 'YYYY-MM-DD', example: '2024-03-03' },
    { header: 'Payment Method',  key: 'paymentMethod',  width: 18, required: false, example: 'CASH' },
    { header: 'Transaction Ref', key: 'transactionRef', width: 26, required: false, example: 'CASH-R001' },
    { header: 'Status',          key: 'status',         width: 12, required: true,  hint: 'PAID / DUE / OVERDUE', example: 'PAID' },
  ],
  PurchaseOrders: [
    { header: 'PO Number',         key: 'purchaseOrderNumber', width: 20, required: true,  hint: 'Same No. for multi-item PO', example: 'PO-2024-0001' },
    { header: 'Order Date',        key: 'orderDate',           width: 14, required: true,  hint: 'YYYY-MM-DD',                example: '2024-01-05' },
    { header: 'Supplier',          key: 'supplier',            width: 26, required: true,  hint: 'Must match Supplier Name',  example: 'Furtados Music' },
    { header: 'Product SKU',       key: 'productSku',          width: 18, required: true,  example: 'SKU-0001' },
    { header: 'Qty Ordered',       key: 'quantityOrdered',     width: 14, required: true,  example: 3 },
    { header: 'Qty Received',      key: 'quantityReceived',    width: 14, required: false, hint: 'Defaults to Qty Ordered',   example: 3 },
    { header: 'Unit Cost',         key: 'unitCost',            width: 14, required: true,  hint: 'Number only',               example: 6000 },
    { header: 'Invoice Reference', key: 'invoiceReference',    width: 24, required: false, example: 'FURT-INV-001' },
    { header: 'Status',            key: 'status',              width: 22, required: false, hint: 'COMPLETED / DRAFT',         example: 'COMPLETED' },
    { header: 'Location',          key: 'location',            width: 18, required: false, example: 'MAIN' },
  ],
};

// ─── 1. Template generation ───────────────────────────────────────────────────

export function generateImportTemplate(): Buffer {
  const wb = XLSX.utils.book_new();

  // ── HOW TO USE sheet ─────────────────────────────────────────────────────────
  const howToUse = [
    ['STEREOBLISS — Historical Data Import', '', '', ''],
    [''],
    ['STEP 1', 'Fill the sheets below IN ORDER (left to right tabs):', '', ''],
    ['', '  1. Categories  2. Suppliers  3. Locations  4. Products  5. Serialized Items', '', ''],
    ['', '  6. Direct Sales  7. EMI Sales  8. EMI Payments  9. Rentals  10. Rental Payments  11. Purchase Orders', '', ''],
    [''],
    ['STEP 2', 'Each sheet has three rows at the top:', '', ''],
    ['', '  Row 1 = Column name (bold). Columns marked REQUIRED must be filled.', '', ''],
    ['', '  Row 2 = Hint / valid values for that column.', '', ''],
    ['', '  Row 3+ = Your data (the sample row shown can be deleted)', '', ''],
    [''],
    ['STEP 3', 'Upload the file. You will see a preview of all data before anything is saved.', '', ''],
    ['', 'You can edit cells directly in the preview screen.', '', ''],
    [''],
    ['KEY RULES', '', '', ''],
    ['', '• Date format:  YYYY-MM-DD  (e.g. 2024-03-15)', '', ''],
    ['', '• Prices / amounts: numbers only — no commas, no Rs symbol (e.g. 8500, not Rs 8,500)', '', ''],
    ['', '• For a sale with multiple products: use the same Invoice No. on multiple rows', '', ''],
    ['', '• Product SKU must match exactly what is on the Products sheet', '', ''],
    ['', '• Already-existing records (same Invoice No., SKU, etc.) are skipped — safe to re-upload', '', ''],
    [''],
    ['ALLOWED VALUES', '', '', ''],
    ['', 'Payment Method:', 'CASH  |  UPI  |  CARD  |  BANK_TRANSFER  |  OTHER', ''],
    ['', 'Tracking Mode:', 'QUANTITY  |  SERIALIZED', ''],
    ['', 'Item Condition:', 'NEW  |  MINT  |  GOOD  |  FAIR  |  POOR  |  DAMAGED', ''],
    ['', 'Rental Status:', 'ACTIVE  |  RETURNED  |  PARTIALLY_RETURNED  |  OVERDUE', ''],
    ['', 'EMI / Rental Payment Status:', 'PAID  |  DUE  |  OVERDUE', ''],
    ['', 'PO Status:', 'COMPLETED  |  PARTIALLY_RECEIVED  |  CONFIRMED  |  DRAFT  |  CANCELLED', ''],
  ];

  const wsHow = XLSX.utils.aoa_to_sheet(howToUse);
  wsHow['!cols'] = [{ wch: 14 }, { wch: 80 }, { wch: 60 }, { wch: 20 }];
  // Bold the headings
  ['A1','A3','A7','A11','A14','A21'].forEach(cell => {
    if (wsHow[cell]) wsHow[cell].s = { font: { bold: true, sz: 12 } };
  });
  XLSX.utils.book_append_sheet(wb, wsHow, 'HOW TO USE');

  // ── Data sheets ───────────────────────────────────────────────────────────────
  for (const [sheetName, cols] of Object.entries(SHEET_COLS)) {
    // Row 1: column headers (plain English, no * suffix)
    const headerRow = cols.map(c => c.header);
    // Row 2: hints
    const hintRow   = cols.map(c => {
      const parts: string[] = [];
      if (c.required) parts.push('REQUIRED');
      if (c.hint)     parts.push(c.hint);
      return parts.join(' — ');
    });
    // Row 3: one example row
    const exampleRow = cols.map(c => c.example !== undefined ? c.example : '');

    const ws = XLSX.utils.aoa_to_sheet([headerRow, hintRow, exampleRow]);
    ws['!cols'] = cols.map(c => ({ wch: c.width }));

    // Style header row (bold + background colour for required cols)
    cols.forEach((col, ci) => {
      const cellAddr = XLSX.utils.encode_cell({ r: 0, c: ci });
      if (!ws[cellAddr]) ws[cellAddr] = { v: col.header, t: 's' };
      ws[cellAddr].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: col.required ? '1a6eb7' : '4a5568' } },
        alignment: { horizontal: 'left' },
        border: { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } },
      };
      // Style hint row
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

  Suppliers: [
    { header: 'name *',          key: 'name',          width: 30 },
    { header: 'contactPerson',   key: 'contactPerson', width: 25 },
    { header: 'email',           key: 'email',         width: 30 },
    { header: 'phone',           key: 'phone',         width: 18 },
    { header: 'address',         key: 'address',       width: 40 },
    { header: 'notes',           key: 'notes',         width: 40 },
  ],
  Locations: [
    { header: 'name *',      key: 'name',      width: 28, note: 'e.g. Main Store' },
    { header: 'code *',      key: 'code',      width: 14, note: 'Short code, e.g. MAIN (auto-uppercased)' },
    { header: 'type',        key: 'type',      width: 14, note: 'STORE | WAREHOUSE | OTHER' },
    { header: 'address',     key: 'address',   width: 40 },
    { header: 'isDefault',   key: 'isDefault', width: 12, note: 'TRUE | FALSE' },
  ],
  Products: [
    { header: 'name *',           key: 'name',               width: 32 },
    { header: 'sku',              key: 'sku',                 width: 16, note: 'Leave blank for auto-generated SKU' },
    { header: 'category *',       key: 'category',            width: 22, note: 'Must match Categories sheet' },
    { header: 'brand',            key: 'brand',               width: 22, note: 'Default: Stereobliss' },
    { header: 'modelName',        key: 'modelName',           width: 22 },
    { header: 'color',            key: 'color',               width: 18 },
    { header: 'hsnCode',          key: 'hsnCode',             width: 14, note: 'Default: 9202' },
    { header: 'trackingMode',     key: 'trackingMode',        width: 16, note: 'QUANTITY | SERIALIZED' },
    { header: 'unitOfMeasure',    key: 'unitOfMeasure',       width: 14, note: 'Default: pcs' },
    { header: 'purchaseCost *',   key: 'purchaseCost',        width: 16 },
    { header: 'sellingPrice *',   key: 'sellingPrice',        width: 16 },
    { header: 'supplier',         key: 'supplier',            width: 24, note: 'Must match Suppliers sheet' },
    { header: 'minStockThreshold',key: 'minStockThreshold',   width: 20, note: 'Default: 5' },
    { header: 'openingStock',     key: 'openingStock',        width: 16, note: 'For QUANTITY mode only' },
    { header: 'location',         key: 'location',            width: 20, note: 'Location code for opening stock' },
    { header: 'description',      key: 'description',         width: 44 },
  ],
  SerializedItems: [
    { header: 'assetId *',           key: 'assetId',           width: 20, note: 'Unique asset tag' },
    { header: 'productSku *',        key: 'productSku',        width: 18, note: 'Must match Products sheet' },
    { header: 'manufacturerSerial',  key: 'manufacturerSerial',width: 22 },
    { header: 'unitCost *',          key: 'unitCost',          width: 14 },
    { header: 'location *',          key: 'location',          width: 20 },
    { header: 'status',              key: 'status',            width: 20, note: 'AVAILABLE | SOLD | ISSUED_INTERNAL | MAINTENANCE | QUARANTINED | RETIRED' },
    { header: 'condition',           key: 'condition',         width: 14, note: 'NEW | MINT | GOOD | FAIR | POOR | DAMAGED' },
    { header: 'warrantyExpiry',      key: 'warrantyExpiry',    width: 18, note: 'YYYY-MM-DD' },
    { header: 'notes',               key: 'notes',             width: 40 },
  ],
  DirectSales: [
    { header: 'invoiceNumber *', key: 'invoiceNumber',  width: 20, note: 'e.g. INV-2024-0001. Use same number on each row for multi-item sale.' },
    { header: 'date *',          key: 'date',           width: 14, note: 'YYYY-MM-DD' },
    { header: 'customerName *',  key: 'customerName',   width: 26 },
    { header: 'customerEmail *', key: 'customerEmail',  width: 30 },
    { header: 'customerPhone *', key: 'customerPhone',  width: 16 },
    { header: 'customerGstin',   key: 'customerGstin',  width: 20 },
    { header: 'customerAddress', key: 'customerAddress',width: 36 },
    { header: 'productSku *',    key: 'productSku',     width: 18 },
    { header: 'quantity *',      key: 'quantity',       width: 12 },
    { header: 'unitPrice *',     key: 'unitPrice',      width: 14 },
    { header: 'discount',        key: 'discount',       width: 12, note: 'Per-unit discount ₹, default 0' },
    { header: 'hsnCode',         key: 'hsnCode',        width: 14, note: 'Default: 9202' },
    { header: 'assetId',         key: 'assetId',        width: 16, note: 'For SERIALIZED products' },
    { header: 'paymentMethod *', key: 'paymentMethod',  width: 18, note: 'CASH | UPI | CARD | BANK_TRANSFER | OTHER' },
    { header: 'paymentStatus',   key: 'paymentStatus',  width: 16, note: 'PAID | PENDING | PARTIAL | REFUNDED' },
    { header: 'dispatchThrough', key: 'dispatchThrough',width: 22 },
    { header: 'destination',     key: 'destination',    width: 18 },
    { header: 'eWayBillNo',      key: 'eWayBillNo',     width: 18 },
    { header: 'notes',           key: 'notes',          width: 36 },
  ],
  EMISales: [
    { header: 'invoiceNumber *',    key: 'invoiceNumber',    width: 20, note: 'Unique invoice number for this EMI sale' },
    { header: 'date *',             key: 'date',             width: 14, note: 'YYYY-MM-DD' },
    { header: 'customerName *',     key: 'customerName',     width: 26 },
    { header: 'customerEmail *',    key: 'customerEmail',    width: 30 },
    { header: 'customerPhone *',    key: 'customerPhone',    width: 16 },
    { header: 'customerGstin',      key: 'customerGstin',    width: 20 },
    { header: 'customerAddress',    key: 'customerAddress',  width: 36 },
    { header: 'productSku *',       key: 'productSku',       width: 18, note: 'Use multiple rows for multi-item sale' },
    { header: 'quantity *',         key: 'quantity',         width: 12 },
    { header: 'unitPrice *',        key: 'unitPrice',        width: 14 },
    { header: 'discount',           key: 'discount',         width: 12 },
    { header: 'hsnCode',            key: 'hsnCode',          width: 14 },
    { header: 'assetId',            key: 'assetId',          width: 16 },
    { header: 'downPayment *',      key: 'downPayment',      width: 16, note: 'Amount paid upfront' },
    { header: 'emiTenureMonths *',  key: 'emiTenureMonths',  width: 18, note: 'Number of monthly instalments' },
    { header: 'downPaymentMethod',  key: 'downPaymentMethod',width: 20, note: 'CASH | UPI | CARD | BANK_TRANSFER' },
    { header: 'notes',              key: 'notes',            width: 36 },
  ],
  EMIPayments: [
    { header: 'invoiceNumber *', key: 'invoiceNumber', width: 20, note: 'Must match an EMISales invoiceNumber' },
    { header: 'monthIndex *',    key: 'monthIndex',    width: 14, note: 'Instalment number starting from 1' },
    { header: 'billingMonth *',  key: 'billingMonth',  width: 24, note: 'e.g. Month 1 (Jan 2024)' },
    { header: 'dueDate *',       key: 'dueDate',       width: 14, note: 'YYYY-MM-DD' },
    { header: 'amountDue *',     key: 'amountDue',     width: 14 },
    { header: 'amountPaid',      key: 'amountPaid',    width: 14, note: 'Default 0' },
    { header: 'paidDate',        key: 'paidDate',      width: 14, note: 'YYYY-MM-DD, blank if unpaid' },
    { header: 'paymentMethod',   key: 'paymentMethod', width: 18 },
    { header: 'transactionRef',  key: 'transactionRef',width: 26 },
    { header: 'status *',        key: 'status',        width: 12, note: 'PAID | DUE | OVERDUE' },
    { header: 'notes',           key: 'notes',         width: 36 },
  ],
  Rentals: [
    { header: 'issueReference *',    key: 'issueReference',    width: 22, note: 'e.g. USE-2024-00001' },
    { header: 'issueDate *',         key: 'issueDate',         width: 14, note: 'YYYY-MM-DD' },
    { header: 'expectedReturnDate *',key: 'expectedReturnDate',width: 22, note: 'YYYY-MM-DD' },
    { header: 'actualReturnDate',    key: 'actualReturnDate',  width: 20, note: 'YYYY-MM-DD, blank if still rented' },
    { header: 'customerName *',      key: 'assignedPerson',    width: 26 },
    { header: 'customerPhone',       key: 'assignedPersonContact',width: 18 },
    { header: 'customerEmail',       key: 'customerEmail',     width: 30 },
    { header: 'productSku *',        key: 'productSku',        width: 18 },
    { header: 'assetId',             key: 'assetId',           width: 16 },
    { header: 'quantityIssued',      key: 'quantityIssued',    width: 16, note: 'Default 1' },
    { header: 'monthlyRent *',       key: 'monthlyRent',       width: 16 },
    { header: 'securityDeposit',     key: 'securityDeposit',   width: 18, note: 'Default 0' },
    { header: 'depositTxnRef',       key: 'depositTransactionRef',width: 22 },
    { header: 'depositMode',         key: 'depositMode',       width: 14, note: 'TRUE | FALSE' },
    { header: 'lockInPeriodMonths',  key: 'lockInPeriodMonths',width: 20, note: 'Default 3' },
    { header: 'status',              key: 'status',            width: 20, note: 'ACTIVE | RETURNED | PARTIALLY_RETURNED | OVERDUE' },
    { header: 'purpose',             key: 'purpose',           width: 18, note: 'CLASS | PRACTICE | REHEARSAL | DEMONSTRATION | EVENT | REPAIR | OTHER' },
    { header: 'accessories',         key: 'includedAccessories',width: 40, note: 'Comma-separated, e.g. Stand, Adapter' },
    { header: 'notes',               key: 'notes',             width: 40 },
  ],
  RentalPayments: [
    { header: 'issueReference *', key: 'issueReference', width: 22, note: 'Must match a Rentals issueReference' },
    { header: 'monthIndex *',     key: 'monthIndex',     width: 14 },
    { header: 'billingMonth *',   key: 'billingMonth',   width: 24 },
    { header: 'dueDate *',        key: 'dueDate',        width: 14 },
    { header: 'amountDue *',      key: 'amountDue',      width: 14 },
    { header: 'amountPaid',       key: 'amountPaid',     width: 14 },
    { header: 'paidDate',         key: 'paidDate',       width: 14 },
    { header: 'paymentMethod',    key: 'paymentMethod',  width: 18 },
    { header: 'transactionRef',   key: 'transactionRef', width: 26 },
    { header: 'status *',         key: 'status',         width: 12, note: 'PAID | DUE | OVERDUE' },
    { header: 'notes',            key: 'notes',          width: 36 },
  ],
  PurchaseOrders: [
    { header: 'poNumber *',         key: 'purchaseOrderNumber',width: 20, note: 'e.g. PO-2024-0001. Same number on each row for multi-product PO.' },
    { header: 'orderDate *',        key: 'orderDate',          width: 14 },
    { header: 'supplier *',         key: 'supplier',           width: 26, note: 'Must match Suppliers sheet' },
    { header: 'productSku *',       key: 'productSku',         width: 18 },
    { header: 'quantityOrdered *',  key: 'quantityOrdered',    width: 18 },
    { header: 'quantityReceived',   key: 'quantityReceived',   width: 18, note: 'Default = quantityOrdered' },
    { header: 'unitCost *',         key: 'unitCost',           width: 14 },
    { header: 'invoiceReference',   key: 'invoiceReference',   width: 24 },
    { header: 'status',             key: 'status',             width: 22, note: 'COMPLETED | PARTIALLY_RECEIVED | CONFIRMED | DRAFT' },
    { header: 'location',           key: 'location',           width: 20 },
    { header: 'notes',              key: 'notes',              width: 40 },
  ],
};

// Sample rows for each sheet (helps users understand expected format)
const SAMPLE_DATA: Record<string, Record<string, unknown>[]> = {
  Categories: [
    { name: 'Guitars',    description: 'Acoustic and electric guitars' },
    { name: 'Keyboards',  description: 'Digital pianos and synthesizers' },
  ],
  Suppliers: [
    { name: 'Furtados Music', contactPerson: 'Raj Kumar', email: 'raj@furtados.com', phone: '9820012345', address: 'Pune', notes: '' },
  ],
  Locations: [
    { name: 'Main Store', code: 'MAIN', type: 'STORE', address: 'Wakad, Pune', isDefault: 'TRUE' },
  ],
  Products: [
    { name: 'Yamaha F310', sku: 'SKU-0001', category: 'Guitars', brand: 'Yamaha', modelName: 'F310', color: 'Natural', hsnCode: '9202', trackingMode: 'SERIALIZED', unitOfMeasure: 'pcs', purchaseCost: 6000, sellingPrice: 8500, supplier: 'Furtados Music', minStockThreshold: 2, openingStock: '', location: 'MAIN', description: '' },
    { name: 'Casio CT-X700', sku: 'SKU-0002', category: 'Keyboards', brand: 'Casio', modelName: 'CT-X700', color: 'Black', hsnCode: '9207', trackingMode: 'QUANTITY', unitOfMeasure: 'pcs', purchaseCost: 5500, sellingPrice: 7200, supplier: 'Furtados Music', minStockThreshold: 3, openingStock: 4, location: 'MAIN', description: '' },
  ],
  SerializedItems: [
    { assetId: 'F310-001', productSku: 'SKU-0001', manufacturerSerial: 'YMH123456', unitCost: 6000, location: 'MAIN', status: 'AVAILABLE', condition: 'NEW', warrantyExpiry: '2026-12-31', notes: '' },
  ],
  DirectSales: [
    { invoiceNumber: 'INV-2024-0001', date: '2024-01-15', customerName: 'Rahul Sharma', customerEmail: 'rahul@gmail.com', customerPhone: '9876543210', customerGstin: '', customerAddress: 'Pune', productSku: 'SKU-0001', quantity: 1, unitPrice: 8500, discount: 0, hsnCode: '9202', assetId: 'F310-001', paymentMethod: 'UPI', paymentStatus: 'PAID', dispatchThrough: 'Hand Delivery', destination: 'PUNE', eWayBillNo: '', notes: '' },
  ],
  EMISales: [
    { invoiceNumber: 'INV-2024-0010', date: '2024-02-01', customerName: 'Priya Desai', customerEmail: 'priya@gmail.com', customerPhone: '9988776655', customerGstin: '', customerAddress: 'Mumbai', productSku: 'SKU-0002', quantity: 1, unitPrice: 7200, discount: 0, hsnCode: '9207', assetId: '', downPayment: 1200, emiTenureMonths: 6, downPaymentMethod: 'CASH', notes: '' },
  ],
  EMIPayments: [
    { invoiceNumber: 'INV-2024-0010', monthIndex: 1, billingMonth: 'Month 1 (Mar 2024)', dueDate: '2024-03-01', amountDue: 1000, amountPaid: 1000, paidDate: '2024-03-05', paymentMethod: 'UPI', transactionRef: 'UPI-998001', status: 'PAID', notes: '' },
    { invoiceNumber: 'INV-2024-0010', monthIndex: 2, billingMonth: 'Month 2 (Apr 2024)', dueDate: '2024-04-01', amountDue: 1000, amountPaid: 0, paidDate: '', paymentMethod: '', transactionRef: '', status: 'DUE', notes: '' },
  ],
  Rentals: [
    { issueReference: 'USE-2024-00001', issueDate: '2024-03-01', expectedReturnDate: '2024-06-01', actualReturnDate: '', assignedPerson: 'Amit Joshi', assignedPersonContact: '9123456780', customerEmail: 'amit@gmail.com', productSku: 'SKU-0001', assetId: 'F310-001', quantityIssued: 1, monthlyRent: 1500, securityDeposit: 5000, depositTransactionRef: 'CASH-001', depositMode: 'FALSE', lockInPeriodMonths: 3, status: 'ACTIVE', purpose: 'CLASS', includedAccessories: 'Stand, Power Adapter', notes: '' },
  ],
  RentalPayments: [
    { issueReference: 'USE-2024-00001', monthIndex: 1, billingMonth: 'Month 1 (Mar 2024)', dueDate: '2024-03-01', amountDue: 1500, amountPaid: 1500, paidDate: '2024-03-03', paymentMethod: 'CASH', transactionRef: 'CASH-R001', status: 'PAID', notes: '' },
  ],
  PurchaseOrders: [
    { purchaseOrderNumber: 'PO-2024-0001', orderDate: '2024-01-05', supplier: 'Furtados Music', productSku: 'SKU-0001', quantityOrdered: 3, quantityReceived: 3, unitCost: 6000, invoiceReference: 'FURT-INV-001', status: 'COMPLETED', location: 'MAIN', notes: '' },
  ],
};

// ─── 1. Template generation ───────────────────────────────────────────────────

export function generateImportTemplate(): Buffer {
  const wb = XLSX.utils.book_new();

  // Instructions sheet
  const instructions = [
    ['Stereobliss Retail — Historical Data Import Template'],
    [''],
    ['INSTRUCTIONS:'],
    ['1. Fill sheets IN ORDER: Categories → Suppliers → Locations → Products → SerializedItems → DirectSales → EMISales → EMIPayments → Rentals → RentalPayments → PurchaseOrders'],
    ['2. Columns with * are REQUIRED.'],
    ['3. Date format must be: YYYY-MM-DD  (e.g. 2024-03-15)'],
    ['4. For multi-item sales or POs, use the same invoiceNumber / poNumber on multiple rows.'],
    ['5. Product SKUs, Supplier names, Location codes must match exactly across sheets.'],
    ['6. SERIALIZED products need rows in SerializedItems sheet; QUANTITY products use openingStock column.'],
    ['7. EMIPayments rows must reference an invoiceNumber that exists in EMISales.'],
    ['8. RentalPayments rows must reference an issueReference that exists in Rentals.'],
    ['9. The second row in each sheet is for notes — do not delete it.'],
    ['10. Existing records are skipped (no duplicates created).'],
    [''],
    ['ENUM VALUES — copy these exactly:'],
    ['trackingMode:     QUANTITY | SERIALIZED'],
    ['paymentMethod:    CASH | UPI | CARD | BANK_TRANSFER | OTHER'],
    ['paymentStatus:    PAID | PENDING | PARTIAL | REFUNDED'],
    ['serializedStatus: AVAILABLE | SOLD | ISSUED_INTERNAL | MAINTENANCE | QUARANTINED | RETIRED'],
    ['condition:        NEW | MINT | GOOD | FAIR | POOR | DAMAGED'],
    ['emiStatus:        PAID | DUE | OVERDUE'],
    ['rentalStatus:     ACTIVE | RETURNED | PARTIALLY_RETURNED | OVERDUE'],
    ['purpose:          CLASS | PRACTICE | REHEARSAL | DEMONSTRATION | EVENT | REPAIR | OTHER'],
    ['poStatus:         COMPLETED | PARTIALLY_RECEIVED | CONFIRMED | DRAFT | CANCELLED'],
  ];
  const wsInstructions = XLSX.utils.aoa_to_sheet(instructions);
  wsInstructions['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  // Data sheets
  for (const [sheetName, cols] of Object.entries(SHEET_COLS)) {
    const headerRow = cols.map(c => c.header);
    const noteRow   = cols.map(c => c.note ?? '');
    const sampleRows = (SAMPLE_DATA[sheetName] ?? []).map(row =>
      cols.map(c => row[c.key] ?? '')
    );

    const ws = XLSX.utils.aoa_to_sheet([headerRow, noteRow, ...sampleRows]);
    ws['!cols'] = cols.map(c => ({ wch: c.width }));

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ─── 2. Validation ────────────────────────────────────────────────────────────

export async function validateImportFile(buf: Buffer): Promise<ValidationResult> {
  const wb    = XLSX.read(buf, { type: 'buffer', raw: false });
  const errors: RowError[] = [];
  let total = 0, valid = 0, skipped = 0;

  const preview: ValidationResult['preview'] = {
    categories: 0, suppliers: 0, locations: 0,
    products: 0, serializedItems: 0,
    directSales: 0, emiSales: 0, emiPaymentRows: 0,
    rentals: 0, rentalPaymentRows: 0, purchaseOrders: 0,
  };

  // Helpers
  const require = (sheet: string, row: number, field: string, val: string): boolean => {
    if (!val) { errors.push({ sheet, row, field, message: `${field} is required` }); return false; }
    return true;
  };
  const mustBeNum = (sheet: string, row: number, field: string, val: string): boolean => {
    if (val !== '' && isNaN(Number(val))) { errors.push({ sheet, row, field, message: `${field} must be a number` }); return false; }
    return true;
  };
  const mustBeDate = (sheet: string, row: number, field: string, val: string): boolean => {
    if (val && !parseDate(val)) { errors.push({ sheet, row, field, message: `${field} must be a valid date (YYYY-MM-DD)` }); return false; }
    return true;
  };
  const mustBeEnum = (sheet: string, row: number, field: string, val: string, allowed: string[]): boolean => {
    if (val && !allowed.includes(val)) { errors.push({ sheet, row, field, message: `${field} must be one of: ${allowed.join(', ')}` }); return false; }
    return true;
  };

  // Collect names / codes from the file for cross-sheet validation
  const catNames = new Set<string>();
  const supplierNames = new Set<string>();
  const locCodes = new Set<string>();
  const prodSkus = new Set<string>();
  const assetIds = new Set<string>();
  const emiInvoices = new Set<string>();
  const rentalRefs = new Set<string>();

  // Pre-load from DB for cross-sheet checks
  (await Category.find({}, { name: 1 }).lean()).forEach((c: any) => catNames.add(c.name.trim()));
  (await Supplier.find({}, { name: 1 }).lean() as any[]).forEach((s: any) => supplierNames.add(s.name.trim()));
  (await StockLocation.find({}, { code: 1, name: 1 }).lean()).forEach((l: any) => {
    locCodes.add(l.code.trim().toUpperCase());
    locCodes.add(l.name.trim().toLowerCase());
  });
  (await Product.find({}, { sku: 1 }).lean()).forEach((p: any) => prodSkus.add(p.sku.trim().toUpperCase()));
  (await SerializedItem.find({}, { assetId: 1 }).lean()).forEach((a: any) => assetIds.add(a.assetId.trim().toUpperCase()));

  const readSheet = (name: string): Record<string, string>[] =>
    wb.SheetNames.includes(name) ? sheetToRows(wb.Sheets[name]) : [];

  // ─ Categories ─
  readSheet('Categories').forEach((r, i) => {
    total++;
    if (!require('Categories', i + 3, 'name', r['name'])) { skipped++; return; }
    catNames.add(r['name'].trim());
    preview.categories++; valid++;
  });

  // ─ Suppliers ─
  readSheet('Suppliers').forEach((r, i) => {
    total++;
    if (!require('Suppliers', i + 3, 'name', r['name'])) { skipped++; return; }
    supplierNames.add(r['name'].trim());
    preview.suppliers++; valid++;
  });

  // ─ Locations ─
  readSheet('Locations').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('Locations', i + 3, 'name', r['name']) && ok;
    ok = require('Locations', i + 3, 'code', r['code']) && ok;
    if (!ok) { skipped++; return; }
    locCodes.add(r['code'].trim().toUpperCase());
    locCodes.add(r['name'].trim().toLowerCase());
    preview.locations++; valid++;
  });

  // ─ Products ─
  const seenSkus = new Set<string>();
  readSheet('Products').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('Products', i + 3, 'name', r['name']) && ok;
    ok = require('Products', i + 3, 'category', r['category']) && ok;
    if (r['category'] && !catNames.has(r['category'].trim())) {
      errors.push({ sheet: 'Products', row: i + 3, field: 'category', message: `Category "${r['category']}" not found` }); ok = false;
    }
    ok = require('Products', i + 3, 'purchaseCost', r['purchaseCost']) && ok;
    ok = mustBeNum('Products', i + 3, 'purchaseCost', r['purchaseCost']) && ok;
    ok = require('Products', i + 3, 'sellingPrice', r['sellingPrice']) && ok;
    ok = mustBeNum('Products', i + 3, 'sellingPrice', r['sellingPrice']) && ok;
    ok = mustBeEnum('Products', i + 3, 'trackingMode', r['trackingMode'], ['', 'QUANTITY', 'SERIALIZED']) && ok;
    const sku = r['sku'] ? r['sku'].trim().toUpperCase() : '';
    if (sku) {
      if (seenSkus.has(sku)) { errors.push({ sheet: 'Products', row: i + 3, field: 'sku', message: `Duplicate SKU "${sku}" in file` }); ok = false; }
      seenSkus.add(sku);
    }
    if (!ok) { skipped++; return; }
    if (sku) prodSkus.add(sku);
    preview.products++; valid++;
  });

  // ─ SerializedItems ─
  const seenAssets = new Set<string>();
  readSheet('SerializedItems').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('SerializedItems', i + 3, 'assetId', r['assetId']) && ok;
    ok = require('SerializedItems', i + 3, 'productSku', r['productSku']) && ok;
    ok = require('SerializedItems', i + 3, 'unitCost', r['unitCost']) && ok;
    ok = mustBeNum('SerializedItems', i + 3, 'unitCost', r['unitCost']) && ok;
    const asset = r['assetId'] ? r['assetId'].trim().toUpperCase() : '';
    if (asset && seenAssets.has(asset)) { errors.push({ sheet: 'SerializedItems', row: i + 3, field: 'assetId', message: `Duplicate assetId "${asset}" in file` }); ok = false; }
    else if (asset && assetIds.has(asset)) { errors.push({ sheet: 'SerializedItems', row: i + 3, field: 'assetId', message: `assetId "${asset}" already exists in database` }); ok = false; }
    if (r['productSku'] && !prodSkus.has(r['productSku'].trim().toUpperCase())) { errors.push({ sheet: 'SerializedItems', row: i + 3, field: 'productSku', message: `Product SKU "${r['productSku']}" not found` }); ok = false; }
    ok = mustBeEnum('SerializedItems', i + 3, 'status', r['status'], ['', ...Object.values(SERIALIZED_STATUSES)]) && ok;
    ok = mustBeEnum('SerializedItems', i + 3, 'condition', r['condition'], ['', ...Object.values(ITEM_CONDITIONS)]) && ok;
    ok = mustBeDate('SerializedItems', i + 3, 'warrantyExpiry', r['warrantyExpiry']) && ok;
    if (!ok) { skipped++; return; }
    seenAssets.add(asset); assetIds.add(asset);
    preview.serializedItems++; valid++;
  });

  // ─ DirectSales ─
  const seenInvoices = new Set<string>();
  readSheet('DirectSales').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('DirectSales', i + 3, 'invoiceNumber', r['invoiceNumber']) && ok;
    ok = require('DirectSales', i + 3, 'date', r['date']) && ok;
    ok = mustBeDate('DirectSales', i + 3, 'date', r['date']) && ok;
    ok = require('DirectSales', i + 3, 'customerName', r['customerName']) && ok;
    ok = require('DirectSales', i + 3, 'customerEmail', r['customerEmail']) && ok;
    ok = require('DirectSales', i + 3, 'customerPhone', r['customerPhone']) && ok;
    ok = require('DirectSales', i + 3, 'productSku', r['productSku']) && ok;
    if (r['productSku'] && !prodSkus.has(r['productSku'].trim().toUpperCase())) { errors.push({ sheet: 'DirectSales', row: i + 3, field: 'productSku', message: `Product SKU "${r['productSku']}" not found` }); ok = false; }
    ok = require('DirectSales', i + 3, 'quantity', r['quantity']) && ok;
    ok = mustBeNum('DirectSales', i + 3, 'quantity', r['quantity']) && ok;
    ok = require('DirectSales', i + 3, 'unitPrice', r['unitPrice']) && ok;
    ok = mustBeNum('DirectSales', i + 3, 'unitPrice', r['unitPrice']) && ok;
    ok = require('DirectSales', i + 3, 'paymentMethod', r['paymentMethod']) && ok;
    ok = mustBeEnum('DirectSales', i + 3, 'paymentMethod', r['paymentMethod'], ['', ...Object.values(PAYMENT_METHODS)]) && ok;
    ok = mustBeEnum('DirectSales', i + 3, 'paymentStatus', r['paymentStatus'], ['', ...Object.values(PAYMENT_STATUSES)]) && ok;
    if (!ok) { skipped++; return; }
    seenInvoices.add(r['invoiceNumber'].trim().toUpperCase());
    preview.directSales++; valid++;
  });

  // ─ EMISales ─
  readSheet('EMISales').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('EMISales', i + 3, 'invoiceNumber', r['invoiceNumber']) && ok;
    if (r['invoiceNumber'] && seenInvoices.has(r['invoiceNumber'].trim().toUpperCase())) {
      errors.push({ sheet: 'EMISales', row: i + 3, field: 'invoiceNumber', message: `"${r['invoiceNumber']}" already used in DirectSales` }); ok = false;
    }
    ok = require('EMISales', i + 3, 'date', r['date']) && ok;
    ok = mustBeDate('EMISales', i + 3, 'date', r['date']) && ok;
    ok = require('EMISales', i + 3, 'customerName', r['customerName']) && ok;
    ok = require('EMISales', i + 3, 'customerEmail', r['customerEmail']) && ok;
    ok = require('EMISales', i + 3, 'customerPhone', r['customerPhone']) && ok;
    ok = require('EMISales', i + 3, 'productSku', r['productSku']) && ok;
    if (r['productSku'] && !prodSkus.has(r['productSku'].trim().toUpperCase())) { errors.push({ sheet: 'EMISales', row: i + 3, field: 'productSku', message: `Product SKU "${r['productSku']}" not found` }); ok = false; }
    ok = require('EMISales', i + 3, 'emiTenureMonths', r['emiTenureMonths']) && ok;
    ok = mustBeNum('EMISales', i + 3, 'emiTenureMonths', r['emiTenureMonths']) && ok;
    ok = mustBeNum('EMISales', i + 3, 'downPayment', r['downPayment']) && ok;
    if (!ok) { skipped++; return; }
    emiInvoices.add(r['invoiceNumber'].trim().toUpperCase());
    preview.emiSales++; valid++;
  });

  // ─ EMIPayments ─
  readSheet('EMIPayments').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('EMIPayments', i + 3, 'invoiceNumber', r['invoiceNumber']) && ok;
    if (r['invoiceNumber'] && !emiInvoices.has(r['invoiceNumber'].trim().toUpperCase())) {
      errors.push({ sheet: 'EMIPayments', row: i + 3, field: 'invoiceNumber', message: `"${r['invoiceNumber']}" not found in EMISales` }); ok = false;
    }
    ok = require('EMIPayments', i + 3, 'monthIndex', r['monthIndex']) && ok;
    ok = mustBeNum('EMIPayments', i + 3, 'monthIndex', r['monthIndex']) && ok;
    ok = require('EMIPayments', i + 3, 'status', r['status']) && ok;
    ok = mustBeEnum('EMIPayments', i + 3, 'status', r['status'], ['PAID', 'DUE', 'OVERDUE']) && ok;
    ok = mustBeDate('EMIPayments', i + 3, 'dueDate', r['dueDate']) && ok;
    if (!ok) { skipped++; return; }
    preview.emiPaymentRows++; valid++;
  });

  // ─ Rentals ─
  const seenRefs = new Set<string>();
  readSheet('Rentals').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('Rentals', i + 3, 'issueReference', r['issueReference']) && ok;
    ok = require('Rentals', i + 3, 'issueDate', r['issueDate']) && ok;
    ok = mustBeDate('Rentals', i + 3, 'issueDate', r['issueDate']) && ok;
    ok = require('Rentals', i + 3, 'expectedReturnDate', r['expectedReturnDate']) && ok;
    ok = mustBeDate('Rentals', i + 3, 'expectedReturnDate', r['expectedReturnDate']) && ok;
    ok = mustBeDate('Rentals', i + 3, 'actualReturnDate', r['actualReturnDate']) && ok;
    ok = require('Rentals', i + 3, 'customerName', r['assignedPerson']) && ok;
    ok = require('Rentals', i + 3, 'productSku', r['productSku']) && ok;
    if (r['productSku'] && !prodSkus.has(r['productSku'].trim().toUpperCase())) { errors.push({ sheet: 'Rentals', row: i + 3, field: 'productSku', message: `Product SKU "${r['productSku']}" not found` }); ok = false; }
    ok = require('Rentals', i + 3, 'monthlyRent', r['monthlyRent']) && ok;
    ok = mustBeNum('Rentals', i + 3, 'monthlyRent', r['monthlyRent']) && ok;
    if (r['issueReference'] && seenRefs.has(r['issueReference'].trim().toUpperCase())) {
      errors.push({ sheet: 'Rentals', row: i + 3, field: 'issueReference', message: `Duplicate issueReference "${r['issueReference']}"` }); ok = false;
    }
    ok = mustBeEnum('Rentals', i + 3, 'status', r['status'], ['', ...Object.values(USAGE_STATUSES)]) && ok;
    ok = mustBeEnum('Rentals', i + 3, 'purpose', r['purpose'], ['', ...Object.values(USAGE_PURPOSES)]) && ok;
    if (!ok) { skipped++; return; }
    seenRefs.add(r['issueReference'].trim().toUpperCase());
    rentalRefs.add(r['issueReference'].trim().toUpperCase());
    preview.rentals++; valid++;
  });

  // ─ RentalPayments ─
  readSheet('RentalPayments').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('RentalPayments', i + 3, 'issueReference', r['issueReference']) && ok;
    if (r['issueReference'] && !rentalRefs.has(r['issueReference'].trim().toUpperCase())) {
      errors.push({ sheet: 'RentalPayments', row: i + 3, field: 'issueReference', message: `"${r['issueReference']}" not found in Rentals` }); ok = false;
    }
    ok = require('RentalPayments', i + 3, 'monthIndex', r['monthIndex']) && ok;
    ok = mustBeNum('RentalPayments', i + 3, 'monthIndex', r['monthIndex']) && ok;
    ok = require('RentalPayments', i + 3, 'status', r['status']) && ok;
    ok = mustBeEnum('RentalPayments', i + 3, 'status', r['status'], ['PAID', 'DUE', 'OVERDUE']) && ok;
    if (!ok) { skipped++; return; }
    preview.rentalPaymentRows++; valid++;
  });

  // ─ PurchaseOrders ─
  readSheet('PurchaseOrders').forEach((r, i) => {
    total++;
    let ok = true;
    ok = require('PurchaseOrders', i + 3, 'poNumber', r['poNumber']) && ok;
    ok = require('PurchaseOrders', i + 3, 'orderDate', r['orderDate']) && ok;
    ok = mustBeDate('PurchaseOrders', i + 3, 'orderDate', r['orderDate']) && ok;
    ok = require('PurchaseOrders', i + 3, 'supplier', r['supplier']) && ok;
    ok = require('PurchaseOrders', i + 3, 'productSku', r['productSku']) && ok;
    if (r['productSku'] && !prodSkus.has(r['productSku'].trim().toUpperCase())) { errors.push({ sheet: 'PurchaseOrders', row: i + 3, field: 'productSku', message: `Product SKU "${r['productSku']}" not found` }); ok = false; }
    ok = require('PurchaseOrders', i + 3, 'quantityOrdered', r['quantityOrdered']) && ok;
    ok = mustBeNum('PurchaseOrders', i + 3, 'quantityOrdered', r['quantityOrdered']) && ok;
    ok = require('PurchaseOrders', i + 3, 'unitCost', r['unitCost']) && ok;
    ok = mustBeNum('PurchaseOrders', i + 3, 'unitCost', r['unitCost']) && ok;
    if (!ok) { skipped++; return; }
    preview.purchaseOrders++; valid++;
  });

  return {
    valid: errors.length === 0,
    totalRows: total,
    validRows: valid,
    skippedRows: skipped,
    errorCount: errors.length,
    errors: errors.slice(0, 500), // cap at 500 to avoid huge payloads
    preview,
  };
}

// ─── 3. Import execution ──────────────────────────────────────────────────────

export async function executeImport(buf: Buffer, actor: AuthenticatedUser): Promise<ImportResult> {
  const t0 = Date.now();
  const wb = XLSX.read(buf, { type: 'buffer', raw: false });

  const errors: RowError[] = [];
  const imported: ImportResult['imported'] = {
    categories: 0, suppliers: 0, locations: 0, products: 0,
    serializedItems: 0, sales: 0, emiSales: 0, rentals: 0,
    purchaseOrders: 0, stockMovements: 0,
  };
  let skipped = 0;

  const actorId = new Types.ObjectId(actor.id);
  const movements: any[] = [];

  const readSheet = (name: string) =>
    wb.SheetNames.includes(name) ? sheetToRows(wb.Sheets[name]) : [];

  // ── Reference maps (populated incrementally) ──────────────────────────────
  const catMap      = new Map<string, Types.ObjectId>(); // name.lower → _id
  const supplierMap = new Map<string, Types.ObjectId>(); // name.lower → _id
  const locMap      = new Map<string, Types.ObjectId>(); // code.upper or name.lower → _id
  const prodMap     = new Map<string, Types.ObjectId>(); // sku.upper → _id
  const assetMap    = new Map<string, Types.ObjectId>(); // assetId.upper → _id

  // Pre-load existing records
  (await Category.find().lean()).forEach((c: any)       => catMap.set(c.name.trim().toLowerCase(), c._id));
  (await Supplier.find().lean() as any[]).forEach((s: any)    => supplierMap.set(s.name.trim().toLowerCase(), s._id));
  (await StockLocation.find().lean()).forEach((l: any)  => { locMap.set(l.code.trim().toUpperCase(), l._id); locMap.set(l.name.trim().toLowerCase(), l._id); });
  (await Product.find().lean()).forEach((p: any)        => prodMap.set(p.sku.trim().toUpperCase(), p._id));
  (await SerializedItem.find().lean()).forEach((a: any) => assetMap.set(a.assetId.trim().toUpperCase(), a._id));

  const resolveLocation = (val: string): Types.ObjectId | undefined => {
    if (!val) return locMap.values().next().value;
    return locMap.get(val.trim().toUpperCase()) ?? locMap.get(val.trim().toLowerCase());
  };
  const defaultLoc = (): Types.ObjectId => {
    const first = locMap.values().next().value;
    if (!first) throw new Error('No stock location found. Add at least one Location before importing.');
    return first;
  };

  // ── Step 1: Categories ────────────────────────────────────────────────────
  for (const r of readSheet('Categories')) {
    if (!r['name']) { skipped++; continue; }
    const key = r['name'].trim().toLowerCase();
    if (catMap.has(key)) continue;
    try {
      const doc = await Category.create({ name: r['name'].trim(), description: r['description'] || undefined });
      catMap.set(key, doc._id as Types.ObjectId);
      imported.categories++;
    } catch (err: any) {
      if (err.code === 11000) {
        const ex = await Category.findOne({ name: new RegExp(`^${r['name'].trim()}$`, 'i') }).lean();
        if (ex) catMap.set(key, (ex as any)._id);
      } else { errors.push({ sheet: 'Categories', row: -1, field: 'name', message: err.message }); }
    }
  }

  // ── Step 2: Suppliers ─────────────────────────────────────────────────────
  for (const r of readSheet('Suppliers')) {
    if (!r['name']) { skipped++; continue; }
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
      if (err.code !== 11000) errors.push({ sheet: 'Suppliers', row: -1, field: 'name', message: err.message });
    }
  }

  // ── Step 3: Locations ─────────────────────────────────────────────────────
  for (const r of readSheet('Locations')) {
    if (!r['name'] || !r['code']) { skipped++; continue; }
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
      if (err.code !== 11000) errors.push({ sheet: 'Locations', row: -1, field: 'code', message: err.message });
    }
  }

  // ── Step 4: Products ──────────────────────────────────────────────────────
  let maxSkuNum = 0;
  for (const [sku] of prodMap) {
    const m = sku.match(/(\d+)$/);
    if (m) maxSkuNum = Math.max(maxSkuNum, parseInt(m[1], 10));
  }

  for (const r of readSheet('Products')) {
    if (!r['name'] || !r['category']) { skipped++; continue; }
    let sku = r['sku'] ? r['sku'].trim().toUpperCase() : '';
    if (!sku || sku === 'AUTO') { maxSkuNum++; sku = `SKU-${String(maxSkuNum).padStart(4, '0')}`; }
    if (prodMap.has(sku)) continue;

    const catId = catMap.get(r['category'].trim().toLowerCase());
    if (!catId) { skipped++; continue; }
    const suppId = r['supplier'] ? supplierMap.get(r['supplier'].trim().toLowerCase()) : undefined;
    const locId  = resolveLocation(r['location'] ?? '');
    const tracking = r['trackingMode'] === 'SERIALIZED' ? TRACKING_MODES.SERIALIZED : TRACKING_MODES.QUANTITY;
    const opening  = parseNum(r['openingStock'], 0);

    try {
      const prod = await Product.create({
        name: r['name'].trim(),
        sku,
        color:                r['color'] || undefined,
        hsnCode:              r['hsnCode'] || '9202',
        category:             catId,
        brand:                r['brand']?.trim() || 'Stereobliss',
        modelName:            r['modelName'] || undefined,
        description:          r['description'] || undefined,
        trackingMode:         tracking,
        unitOfMeasure:        r['unitOfMeasure'] || 'pcs',
        purchaseCost:         parseNum(r['purchaseCost']),
        defaultSellingPrice:  parseNum(r['sellingPrice'] ?? r['defaultSellingPrice']),
        supplier:             suppId ?? undefined,
        minStockThreshold:    parseNum(r['minStockThreshold'], 5),
        stockQuantity: {
          onHand: tracking === TRACKING_MODES.QUANTITY ? opening : 0,
          reserved: 0, issuedInternal: 0, quarantined: 0,
        },
        locationStock: locId && tracking === TRACKING_MODES.QUANTITY && opening > 0
          ? [{ location: locId, onHand: opening, reserved: 0, issuedInternal: 0, quarantined: 0 }]
          : locId ? [{ location: locId, onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 }]
          : [],
        isActive: true,
      });
      prodMap.set(sku, prod._id as Types.ObjectId);
      imported.products++;

      if (tracking === TRACKING_MODES.QUANTITY && opening > 0 && locId) {
        movements.push({
          product: prod._id, location: locId,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: opening,
          transactionRef: `HIST-IMPORT-${sku}`, transactionModel: 'HistoricalImport',
          reason: `Historical opening stock for ${r['name']}`, performedBy: actorId,
        });
        imported.stockMovements++;
      }
    } catch (err: any) {
      if (err.code === 11000) {
        const ex = await Product.findOne({ sku }).lean();
        if (ex) prodMap.set(sku, (ex as any)._id);
      } else { errors.push({ sheet: 'Products', row: -1, field: 'sku', message: `${sku}: ${err.message}` }); }
    }
  }

  // ── Step 5: SerializedItems ───────────────────────────────────────────────
  for (const r of readSheet('SerializedItems')) {
    if (!r['assetId'] || !r['productSku']) { skipped++; continue; }
    const assetId = r['assetId'].trim().toUpperCase();
    if (assetMap.has(assetId)) { skipped++; continue; }
    const prodId = prodMap.get(r['productSku'].trim().toUpperCase());
    const locId  = resolveLocation(r['location'] ?? '') ?? defaultLoc();
    if (!prodId) { skipped++; continue; }

    const status    = Object.values(SERIALIZED_STATUSES).includes(r['status'] as any) ? (r['status'] as any) : SERIALIZED_STATUSES.AVAILABLE;
    const condition = Object.values(ITEM_CONDITIONS).includes(r['condition'] as any) ? (r['condition'] as any) : ITEM_CONDITIONS.NEW;

    try {
      const item = await SerializedItem.create({
        assetId,
        manufacturerSerial: r['manufacturerSerial'] ? r['manufacturerSerial'].trim().toUpperCase() : undefined,
        product: prodId, unitCost: parseNum(r['unitCost']),
        location: locId, status, condition,
        warrantyExpiry: parseDate(r['warrantyExpiry']) ?? undefined,
        notes: r['notes'] || undefined,
      });
      assetMap.set(assetId, item._id as Types.ObjectId);
      imported.serializedItems++;

      // Update product stock count
      const delta = status === SERIALIZED_STATUSES.AVAILABLE ? 1
        : status === SERIALIZED_STATUSES.SOLD ? 0 : 1;
      if (status === SERIALIZED_STATUSES.AVAILABLE) {
        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': 1 } });
        // Ensure locationStock entry exists
        const prod = await Product.findById(prodId);
        if (prod) {
          const hasLoc = prod.locationStock.some(ls => ls.location.toString() === locId.toString());
          if (!hasLoc) prod.locationStock.push({ location: locId, onHand: 1, reserved: 0, issuedInternal: 0, quarantined: 0 });
          else { const ls = prod.locationStock.find(l => l.location.toString() === locId.toString()); if (ls) ls.onHand += 1; }
          await prod.save();
        }
        movements.push({
          product: prodId, serializedItem: item._id, location: locId,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT, quantityDelta: 0,
          destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
          transactionRef: `HIST-ASSET-${assetId}`, transactionModel: 'HistoricalImport',
          reason: `Historical serialized item ${assetId} imported`, performedBy: actorId,
        });
        imported.stockMovements++;
      }
    } catch (err: any) {
      if (err.code !== 11000) errors.push({ sheet: 'SerializedItems', row: -1, field: 'assetId', message: `${assetId}: ${err.message}` });
    }
  }

  // ── Step 6: Direct Sales ──────────────────────────────────────────────────
  {
    const rows = readSheet('DirectSales');
    // Group by invoiceNumber (multi-item support)
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['invoiceNumber']) continue;
      const inv = r['invoiceNumber'].trim().toUpperCase();
      if (!groups.has(inv)) groups.set(inv, []);
      groups.get(inv)!.push(r);
    }

    for (const [invoiceNumber, lines] of groups) {
      if (await Sale.exists({ invoiceNumber })) { skipped++; continue; }
      const first   = lines[0];
      const saleDate = parseDate(first['date']) ?? new Date();
      const locId   = defaultLoc();

      const lineItems: any[] = [];
      let subtotal = 0, discountTotal = 0;

      for (const line of lines) {
        const sku    = (line['productSku'] ?? '').trim().toUpperCase();
        const prodId = prodMap.get(sku);
        if (!prodId) continue;
        const qty   = parseNum(line['quantity'], 1);
        const price = parseNum(line['unitPrice']);
        const disc  = parseNum(line['discount'], 0);
        const net   = Math.max(0, (price - disc) * qty);
        subtotal      += price * qty;
        discountTotal += disc * qty;

        const serializedIds: Types.ObjectId[] = [];
        if (line['assetId']) {
          const aid = assetMap.get(line['assetId'].trim().toUpperCase());
          if (aid) { serializedIds.push(aid); await SerializedItem.findByIdAndUpdate(aid, { status: SERIALIZED_STATUSES.SOLD }); }
        }

        lineItems.push({
          product: prodId, quantity: qty, unitPrice: price, discount: disc,
          hsnCode: line['hsnCode'] || '9202',
          taxableAmount: net,
          cgstAmount: Math.round(net * 0.09 * 100) / 100,
          sgstAmount: Math.round(net * 0.09 * 100) / 100,
          total: net, serializedItemIds: serializedIds,
        });

        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': -qty } });
        movements.push({
          product: prodId, serializedItem: serializedIds[0], location: locId,
          movementType: MOVEMENT_TYPES.SALE, quantityDelta: -qty,
          transactionRef: invoiceNumber, transactionModel: 'Sale',
          reason: `Historical sale ${invoiceNumber}`, performedBy: actorId,
        });
        imported.stockMovements++;
      }

      if (!lineItems.length) { skipped++; continue; }

      const taxable  = Math.max(0, subtotal - discountTotal);
      const cgst     = Math.round(taxable * 0.09 * 100) / 100;
      const sgst     = cgst;
      const grand    = Math.round((taxable + cgst + sgst) * 100) / 100;
      const pmStatus = Object.values(PAYMENT_STATUSES).includes(first['paymentStatus'] as any) ? first['paymentStatus'] as any : PAYMENT_STATUSES.PAID;
      const pmMethod = Object.values(PAYMENT_METHODS).includes(first['paymentMethod'] as any)  ? first['paymentMethod'] as any  : PAYMENT_METHODS.UPI;

      try {
        await Sale.create({
          invoiceNumber,
          customerName: first['customerName'], customerEmail: first['customerEmail'].toLowerCase(),
          customerPhone: first['customerPhone'], customerGstin: first['customerGstin'] || undefined,
          customerAddress: first['customerAddress'] || undefined,
          dispatchThrough: first['dispatchThrough'] || undefined, destination: first['destination'] || undefined,
          eWayBillNo: first['eWayBillNo'] || undefined,
          location: locId, lineItems,
          subtotal, discountTotal, taxableAmount: taxable,
          cgstRate: 9, cgstAmount: cgst, sgstRate: 9, sgstAmount: sgst,
          taxTotal: cgst + sgst, grandTotal: grand,
          paymentStatus: pmStatus, paymentMethod: pmMethod,
          saleStatus: SALE_STATUSES.CONFIRMED, saleType: SALE_TYPES.DIRECT, isEmi: false,
          soldBy: actorId, confirmedAt: saleDate,
          notes: first['notes'] || undefined,
          idempotencyKey: `HIST-${invoiceNumber}`,
          createdAt: saleDate,
        });
        imported.sales++;
      } catch (err: any) {
        if (err.code !== 11000) errors.push({ sheet: 'DirectSales', row: -1, field: 'invoiceNumber', message: `${invoiceNumber}: ${err.message}` });
        else skipped++;
      }
    }
  }

  // ── Step 7 + 8: EMI Sales + Payments ─────────────────────────────────────
  const emiPayRows = readSheet('EMIPayments');
  {
    const rows = readSheet('EMISales');
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['invoiceNumber']) continue;
      const inv = r['invoiceNumber'].trim().toUpperCase();
      if (!groups.has(inv)) groups.set(inv, []);
      groups.get(inv)!.push(r);
    }

    for (const [invoiceNumber, lines] of groups) {
      if (await Sale.exists({ invoiceNumber })) { skipped++; continue; }
      const first    = lines[0];
      const saleDate = parseDate(first['date']) ?? new Date();
      const locId    = defaultLoc();
      const tenure   = parseNum(first['emiTenureMonths'], 6);
      const downPay  = parseNum(first['downPayment'], 0);

      const lineItems: any[] = [];
      let subtotal = 0, discountTotal = 0;

      for (const line of lines) {
        const sku    = (line['productSku'] ?? '').trim().toUpperCase();
        const prodId = prodMap.get(sku);
        if (!prodId) continue;
        const qty  = parseNum(line['quantity'], 1);
        const price= parseNum(line['unitPrice']);
        const disc = parseNum(line['discount'], 0);
        const net  = Math.max(0, (price - disc) * qty);
        subtotal      += price * qty; discountTotal += disc * qty;

        const serializedIds: Types.ObjectId[] = [];
        if (line['assetId']) {
          const aid = assetMap.get(line['assetId'].trim().toUpperCase());
          if (aid) { serializedIds.push(aid); await SerializedItem.findByIdAndUpdate(aid, { status: SERIALIZED_STATUSES.SOLD }); }
        }
        lineItems.push({ product: prodId, quantity: qty, unitPrice: price, discount: disc, hsnCode: line['hsnCode'] || '9202', taxableAmount: net, cgstAmount: Math.round(net * 0.09 * 100) / 100, sgstAmount: Math.round(net * 0.09 * 100) / 100, total: net, serializedItemIds: serializedIds });
        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': -qty } });
        movements.push({ product: prodId, serializedItem: serializedIds[0], location: locId, movementType: MOVEMENT_TYPES.SALE, quantityDelta: -qty, transactionRef: invoiceNumber, transactionModel: 'Sale', reason: `Historical EMI sale ${invoiceNumber}`, performedBy: actorId });
        imported.stockMovements++;
      }
      if (!lineItems.length) { skipped++; continue; }

      const taxable = Math.max(0, subtotal - discountTotal);
      const cgst    = Math.round(taxable * 0.09 * 100) / 100;
      const sgst    = cgst;
      const grand   = Math.round((taxable + cgst + sgst) * 100) / 100;
      const financed = Math.max(0, grand - downPay);
      const monthly  = tenure > 0 ? Math.round(financed / tenure) : 0;

      // Build schedule
      const schedRows = emiPayRows.filter(r => (r['invoiceNumber'] ?? '').trim().toUpperCase() === invoiceNumber);
      let emiPayments: any[] = [], emiPaid = downPay, emiDue = 0;

      if (schedRows.length > 0) {
        emiPayments = schedRows.map(p => {
          const due  = parseNum(p['amountDue'], 0);
          const paid = parseNum(p['amountPaid'], 0);
          emiPaid += paid; emiDue += Math.max(0, due - paid);
          return { monthIndex: parseNum(p['monthIndex'], 1), billingMonth: p['billingMonth'] || `Month ${p['monthIndex']}`, dueDate: parseDate(p['dueDate']) ?? saleDate, amountDue: due, amountPaid: paid, paidAt: parseDate(p['paidDate']) ?? undefined, paymentMethod: p['paymentMethod'] || undefined, transactionRef: p['transactionRef'] || undefined, status: (['PAID', 'DUE', 'OVERDUE'].includes(p['status']) ? p['status'] : 'DUE') as any, notes: p['notes'] || undefined };
        });
      } else {
        for (let m = 1; m <= tenure; m++) {
          const d = new Date(saleDate); d.setMonth(d.getMonth() + m);
          emiPayments.push({ monthIndex: m, billingMonth: `Month ${m}`, dueDate: d, amountDue: monthly, amountPaid: 0, status: 'DUE' });
          emiDue += monthly;
        }
      }

      const pmStatus = emiDue <= 0 ? PAYMENT_STATUSES.PAID : emiPaid > 0 ? PAYMENT_STATUSES.PARTIAL : PAYMENT_STATUSES.PENDING;

      try {
        await Sale.create({
          invoiceNumber,
          customerName: first['customerName'], customerEmail: first['customerEmail'].toLowerCase(),
          customerPhone: first['customerPhone'], customerGstin: first['customerGstin'] || undefined,
          customerAddress: first['customerAddress'] || undefined,
          location: locId, lineItems,
          subtotal, discountTotal, taxableAmount: taxable,
          cgstRate: 9, cgstAmount: cgst, sgstRate: 9, sgstAmount: sgst,
          taxTotal: cgst + sgst, grandTotal: grand,
          paymentStatus: pmStatus as any,
          paymentMethod: (Object.values(PAYMENT_METHODS).includes(first['downPaymentMethod'] as any) ? first['downPaymentMethod'] : PAYMENT_METHODS.UPI) as any,
          saleStatus: SALE_STATUSES.CONFIRMED, saleType: SALE_TYPES.EMI, isEmi: true,
          downPayment: downPay, emiTenureMonths: tenure, monthlyEmiAmount: monthly,
          totalEmiPaid: emiPaid, totalEmiDue: emiDue, emiPayments,
          paymentLogs: downPay > 0 ? [{ paymentType: 'DOWN_PAYMENT', amount: downPay, paymentMethod: PAYMENT_METHODS.UPI, transactionRef: `HIST-DP-${invoiceNumber}`, billingMonth: 'Down Payment', notes: 'Historical import', recordedBy: actorId, paidAt: saleDate }] : [],
          soldBy: actorId, confirmedAt: saleDate,
          notes: first['notes'] || undefined,
          idempotencyKey: `HIST-${invoiceNumber}`,
          createdAt: saleDate,
        });
        imported.emiSales++;
      } catch (err: any) {
        if (err.code !== 11000) errors.push({ sheet: 'EMISales', row: -1, field: 'invoiceNumber', message: `${invoiceNumber}: ${err.message}` });
        else skipped++;
      }
    }
  }

  // ── Step 9 + 10: Rentals + RentalPayments ────────────────────────────────
  const rentalPayRows = readSheet('RentalPayments');
  for (const r of readSheet('Rentals')) {
    if (!r['issueReference'] || !r['productSku']) { skipped++; continue; }
    const ref = r['issueReference'].trim().toUpperCase();
    if (await InternalUsage.exists({ issueReference: ref })) { skipped++; continue; }

    const prodId    = prodMap.get(r['productSku'].trim().toUpperCase());
    if (!prodId) { skipped++; continue; }
    const locId     = defaultLoc();
    const issueDate = parseDate(r['issueDate']) ?? new Date();
    const expReturn = parseDate(r['expectedReturnDate']) ?? new Date();
    const actReturn = parseDate(r['actualReturnDate']);
    const status    = Object.values(USAGE_STATUSES).includes(r['status'] as any) ? (r['status'] as any) : USAGE_STATUSES.ACTIVE;
    const purpose   = Object.values(USAGE_PURPOSES).includes(r['purpose'] as any) ? (r['purpose'] as any) : USAGE_PURPOSES.CLASS;
    const serialId  = r['assetId'] ? assetMap.get(r['assetId'].trim().toUpperCase()) : undefined;
    const qty       = parseNum(r['quantityIssued'], 1);
    const monthly   = parseNum(r['monthlyRent'], 0);
    const deposit   = parseNum(r['securityDeposit'], 0);
    const lockIn    = parseNum(r['lockInPeriodMonths'], 3);
    const depMode   = parseBool(r['depositMode']);
    const accessories = r['includedAccessories'] ? r['includedAccessories'].split(',').map(s => s.trim()).filter(Boolean) : [];

    const schedRows   = rentalPayRows.filter(p => (p['issueReference'] ?? '').trim().toUpperCase() === ref);
    let monthlyPayments: any[] = [], totalPaid = 0, totalDue = 0;
    const paymentLogs: any[] = [];

    if (deposit > 0) {
      paymentLogs.push({ paymentType: 'SECURITY_DEPOSIT', amount: deposit, paymentMethod: 'CASH', transactionRef: r['depositTransactionRef'] || `HIST-DEP-${ref}`, billingMonth: 'Security Deposit', notes: 'Historical import', recordedBy: actorId, paidAt: issueDate });
    }

    if (schedRows.length > 0) {
      monthlyPayments = schedRows.map(p => {
        const due  = parseNum(p['amountDue'], 0);
        const paid = parseNum(p['amountPaid'], 0);
        totalPaid += paid; totalDue += Math.max(0, due - paid);
        if (paid > 0) paymentLogs.push({ paymentType: 'RENTAL_PAYMENT', amount: paid, paymentMethod: p['paymentMethod'] || 'CASH', transactionRef: p['transactionRef'] || `HIST-RENT-${ref}-M${p['monthIndex']}`, billingMonth: p['billingMonth'], notes: 'Historical import', recordedBy: actorId, paidAt: parseDate(p['paidDate']) ?? issueDate });
        return { monthIndex: parseNum(p['monthIndex'], 1), billingMonth: p['billingMonth'] || `Month ${p['monthIndex']}`, dueDate: parseDate(p['dueDate']) ?? issueDate, amountDue: due, amountPaid: paid, paidAt: parseDate(p['paidDate']) ?? undefined, paymentMethod: p['paymentMethod'] || undefined, transactionRef: p['transactionRef'] || undefined, status: (['PAID', 'DUE', 'OVERDUE'].includes(p['status']) ? p['status'] : 'DUE') as any, notes: p['notes'] || undefined };
      });
    } else {
      for (let m = 1; m <= lockIn; m++) {
        const d = new Date(issueDate); d.setMonth(d.getMonth() + (m - 1));
        monthlyPayments.push({ monthIndex: m, billingMonth: `Month ${m}`, dueDate: d, amountDue: monthly, amountPaid: 0, status: 'DUE' });
        totalDue += monthly;
      }
    }

    try {
      const usage = await InternalUsage.create({
        issueReference: ref, purpose,
        assignedPerson: r['assignedPerson'].trim(),
        assignedPersonContact: r['assignedPersonContact'] || undefined,
        customerEmail: r['customerEmail'] ? r['customerEmail'].toLowerCase() : undefined,
        location: locId,
        items: [{ product: prodId, quantityIssued: qty, quantityReturned: status === USAGE_STATUSES.RETURNED ? qty : 0, serializedItemId: serialId ?? undefined, issueCondition: ITEM_CONDITIONS.GOOD }],
        issueDate, expectedReturnDate: expReturn, actualReturnDate: actReturn ?? undefined, status,
        notes: r['notes'] || undefined, issuedBy: actorId, isRental: true,
        lockInPeriodMonths: lockIn, securityDeposit: deposit,
        depositTransactionRef: r['depositTransactionRef'] || '',
        depositMode: depMode, depositBalance: depMode ? Math.max(0, deposit - totalPaid) : 0,
        depositExhausted: depMode ? deposit - totalPaid <= 0 : false,
        monthlyRent: monthly, includedAccessories: accessories,
        monthlyPayments, totalRentPaid: totalPaid, totalRentDue: totalDue,
        paymentLogs, createdAt: issueDate,
      });

      if (serialId && status === USAGE_STATUSES.ACTIVE) {
        await SerializedItem.findByIdAndUpdate(serialId, { status: SERIALIZED_STATUSES.ISSUED_INTERNAL, currentUsage: usage._id, assignedTo: r['assignedPerson'].trim() });
      }
      if (status === USAGE_STATUSES.ACTIVE) {
        await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.issuedInternal': qty } });
      }

      imported.rentals++;
      movements.push({ product: prodId, serializedItem: serialId, location: locId, movementType: MOVEMENT_TYPES.INTERNAL_ISSUE, quantityDelta: 0, transactionRef: ref, transactionModel: 'InternalUsage', reason: `Historical rental ${ref}`, performedBy: actorId });
      imported.stockMovements++;
    } catch (err: any) {
      if (err.code !== 11000) errors.push({ sheet: 'Rentals', row: -1, field: 'issueReference', message: `${ref}: ${err.message}` });
      else skipped++;
    }
  }

  // ── Step 11: Purchase Orders ──────────────────────────────────────────────
  {
    const rows   = readSheet('PurchaseOrders');
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r['poNumber']) continue;
      const po = r['poNumber'].trim().toUpperCase();
      if (!groups.has(po)) groups.set(po, []);
      groups.get(po)!.push(r);
    }

    for (const [poNumber, lines] of groups) {
      if (await Purchase.exists({ purchaseOrderNumber: poNumber })) { skipped++; continue; }
      const first   = lines[0];
      const orderDate = parseDate(first['orderDate']) ?? new Date();
      const locId   = resolveLocation(first['location'] ?? '') ?? defaultLoc();
      const suppId  = supplierMap.get(first['supplier'].trim().toLowerCase());
      if (!suppId) { skipped++; continue; }

      const poStatus = Object.values(PURCHASE_STATUSES).includes(first['status'] as any) ? (first['status'] as any) : PURCHASE_STATUSES.COMPLETED;

      const poLines: any[] = [];
      let poSubtotal = 0;

      for (const line of lines) {
        const sku    = (line['productSku'] ?? '').trim().toUpperCase();
        const prodId = prodMap.get(sku);
        if (!prodId) continue;
        const qtyOrd = parseNum(line['quantityOrdered'], 0);
        const qtyRec = parseNum(line['quantityReceived'] || line['quantityOrdered'], qtyOrd);
        const cost   = parseNum(line['unitCost'], 0);
        poSubtotal  += cost * qtyOrd;
        poLines.push({ product: prodId, quantityOrdered: qtyOrd, quantityReceived: qtyRec, unitCost: cost, totalCost: cost * qtyOrd });

        // Update product stock for received quantity
        if (qtyRec > 0) {
          await Product.findByIdAndUpdate(prodId, { $inc: { 'stockQuantity.onHand': qtyRec } });
          const prod = await Product.findById(prodId);
          if (prod) {
            const ls = prod.locationStock.find(l => l.location.toString() === locId.toString());
            if (ls) ls.onHand += qtyRec;
            else prod.locationStock.push({ location: locId, onHand: qtyRec, reserved: 0, issuedInternal: 0, quarantined: 0 });
            await prod.save();
          }
          movements.push({ product: prodId, location: locId, movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT, quantityDelta: qtyRec, transactionRef: poNumber, transactionModel: 'Purchase', reason: `Historical PO ${poNumber}`, performedBy: actorId });
          imported.stockMovements++;
        }
      }
      if (!poLines.length) { skipped++; continue; }

      try {
        const po = await Purchase.create({
          purchaseOrderNumber: poNumber, supplier: suppId,
          invoiceReference: first['invoiceReference'] || undefined,
          orderDate, lineItems: poLines, subtotal: poSubtotal,
          additionalCosts: 0, totalCost: poSubtotal, status: poStatus,
          destinationLocation: locId, notes: first['notes'] || undefined,
          createdBy: actorId,
          createdAt: orderDate,
        });

        // Create a PurchaseReceipt for completed POs
        if (poStatus === PURCHASE_STATUSES.COMPLETED) {
          let receiptCount = await PurchaseReceipt.countDocuments();
          const rcptNum = `RCPT-${new Date(orderDate).getFullYear()}-${String(receiptCount + 1).padStart(5, '0')}`;
          await PurchaseReceipt.create({
            receiptNumber: rcptNum, purchase: po._id,
            receivedDate: orderDate,
            lineItems: poLines.map(l => ({ product: l.product, quantityReceived: l.quantityReceived, unitCost: l.unitCost })),
            destinationLocation: locId, receivedBy: actorId,
            notes: 'Historical import',
            createdAt: orderDate,
          });
        }
        imported.purchaseOrders++;
      } catch (err: any) {
        if (err.code !== 11000) errors.push({ sheet: 'PurchaseOrders', row: -1, field: 'poNumber', message: `${poNumber}: ${err.message}` });
        else skipped++;
      }
    }
  }

  // ── Write all stock movements in bulk ─────────────────────────────────────
  if (movements.length > 0) {
    try {
      await StockMovement.insertMany(movements, { ordered: false });
    } catch (err: any) {
      // Swallow duplicate-key errors from idempotencyKey — movements that already exist are fine
      if (err.code !== 11000 && err.name !== 'MongoBulkWriteError') {
        errors.push({ sheet: 'System', row: -1, field: 'stockMovements', message: err.message });
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
