import * as XLSX from 'xlsx';
import { Types } from 'mongoose';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { StockLocation } from '../models/StockLocation.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockMovement } from '../models/StockMovement.js';
import {
  TRACKING_MODES,
  TrackingMode,
  SERIALIZED_STATUSES,
  ITEM_CONDITIONS,
  MOVEMENT_TYPES,
} from '../config/constants.js';
import { AuthenticatedUser } from '../middleware/auth.js';
import { logAudit } from './auditService.js';
import { getNextSku } from './inventoryService.js';

export interface ProductImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface ProductBulkImportResult {
  success: boolean;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  initialStockCreated: number;
  products: Array<{
    _id: string;
    name: string;
    sku: string;
    brand: string;
    categoryName: string;
    color?: string;
    hsnCode?: string;
    unitOfMeasure: string;
    minStockThreshold: number;
    initialStock?: number;
  }>;
  errors: ProductImportRowError[];
}

/**
 * Generate a clean, sample-filled Excel template (.xlsx) for bulk product catalog intake.
 */
export function generateProductCatalogTemplate(): Buffer {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Products ──
  const headers = [
    'Brand',
    'Product Name *',
    'Model / Series Name',
    'Category *',
    'Color',
    'HSN Code',
    'Low Stock Alert',
    'Unit of Measure',
    'Purchase Cost',
    'Selling Price',
    'Tracking Mode',
    'Opening Stock',
    'Serial Numbers (if Serialized)',
    'Location Code',
    'SKU (Optional)',
    'Description',
  ];

  const hints = [
    'e.g. Yamaha, Fender, Roland, Gibson',
    'Full product title (REQUIRED)',
    'e.g. Pacifica 112V, F310, Player Series',
    'e.g. Guitars, Keyboards, Audio (Auto-creates if new)',
    'e.g. Natural, Sunburst, Black, Metallic Red',
    'Standard HSN code (e.g. 9202, 9207)',
    'Min stock warning count (Default: 5)',
    'pcs / set / unit (Default: pcs)',
    'Wholesale / buying cost (₹)',
    'Retail MRP / selling price (₹)',
    'SERIALIZED (Asset barcode tracking) or QUANTITY',
    'Initial stock count to populate on hand (Default: 0)',
    'Comma-separated manufacturer serials / barcodes',
    'Outlet code (Default: CENTRAL)',
    'Leave blank for auto-generated sequential SKU',
    'Optional specifications or product notes',
  ];

  const sampleRows = [
    [
      'Yamaha',
      'F310 Acoustic Guitar',
      'F310',
      'Acoustic Guitars',
      'Natural',
      '9202',
      3,
      'pcs',
      7200,
      9800,
      'SERIALIZED',
      3,
      'YMH-F310-001, YMH-F310-002, YMH-F310-003',
      'CENTRAL',
      '',
      'Traditional western body with spruce top and rosewood fretboard',
    ],
    [
      'Fender',
      'Player Stratocaster Maple Fretboard',
      'Player Series',
      'Electric Guitars',
      '3-Color Sunburst',
      '9202',
      2,
      'pcs',
      45000,
      62000,
      'SERIALIZED',
      2,
      'FND-STRAT-901, FND-STRAT-902',
      'CENTRAL',
      '',
      'Alder body with modern C neck profile and 3 single-coil pickups',
    ],
    [
      'Roland',
      'FP-30X Digital Piano',
      'FP-X Series',
      'Keyboards',
      'Black',
      '9207',
      2,
      'pcs',
      52000,
      69000,
      'SERIALIZED',
      2,
      'ROL-FP30-401, ROL-FP30-402',
      'CENTRAL',
      '',
      'SuperNATURAL piano sound engine with 88-note PHA-4 standard keyboard',
    ],
    [
      "D'Addario",
      'EJ16 Phosphor Bronze Light Acoustic Strings',
      'EJ16',
      'Accessories',
      'Light Bronze',
      '9209',
      10,
      'set',
      450,
      750,
      'QUANTITY',
      50,
      '',
      'CENTRAL',
      '',
      'Corrosion resistant packaging, warm bright acoustic tone',
    ],
    [
      'Shure',
      'SM58 Dynamic Vocal Microphone',
      'SM58',
      'Microphones',
      'Dark Grey',
      '8518',
      4,
      'pcs',
      7400,
      9900,
      'SERIALIZED',
      4,
      'SHR-SM58-101, SHR-SM58-102, SHR-SM58-103, SHR-SM58-104',
      'CENTRAL',
      '',
      'Legendary cardioid dynamic vocal microphone for live stage performance',
    ],
  ];

  const wsData = [headers, hints, ...sampleRows];
  const wsProducts = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths
  wsProducts['!cols'] = [
    { wch: 18 }, // Brand
    { wch: 34 }, // Product Name
    { wch: 22 }, // Model / Series Name
    { wch: 20 }, // Category
    { wch: 16 }, // Color
    { wch: 12 }, // HSN Code
    { wch: 16 }, // Low Stock Alert
    { wch: 16 }, // Unit of Measure
    { wch: 16 }, // Purchase Cost
    { wch: 16 }, // Selling Price
    { wch: 16 }, // Tracking Mode
    { wch: 15 }, // Opening Stock
    { wch: 35 }, // Serial Numbers
    { wch: 15 }, // Location Code
    { wch: 18 }, // SKU
    { wch: 40 }, // Description
  ];

  XLSX.utils.book_append_sheet(wb, wsProducts, 'Product Catalog');

  // ── Sheet 2: Instructions ──
  const instructions = [
    ['STEREOBLISS — Bulk Product Catalog Excel Import Guide'],
    [''],
    ['QUICK INSTRUCTIONS:'],
    ['1. Fill the "Product Catalog" sheet with your items (Row 3 onwards).'],
    ['2. You can delete or overwrite the sample rows provided.'],
    ['3. "Product Name" and "Category" are the only strictly required fields.'],
    ['4. Categories are created automatically if they do not already exist in the system.'],
    ['5. SKUs will be automatically generated sequentially (e.g. SKU-0001, SKU-0002) if left blank.'],
    ['6. "Tracking Mode" supports either SERIALIZED (for instruments with individual asset IDs/serials) or QUANTITY (for strings, picks, cables).'],
    ['7. "Opening Stock": Enter your existing inventory count. The system will automatically create initial on-hand stock and balance movements.'],
    ['8. "Serial Numbers": For SERIALIZED items, you can provide comma-separated serials or barcodes (e.g. SN1, SN2). If omitted but Opening Stock > 0, sequential asset IDs (e.g. SKU-0001-01) are auto-generated.'],
    ['9. Upload the completed .xlsx file via Settings or Product Catalog page.'],
    [''],
    ['COLUMN DEFINITIONS:'],
    ['• Brand: Manufacturer or brand name (e.g. Yamaha, Fender, Gibson, Stereobliss). Defaults to Stereobliss if omitted.'],
    ['• Product Name: Complete commercial title of the item.'],
    ['• Model / Series Name: Model number or series classification (e.g. Pacifica, F310, SM58).'],
    ['• Category: Equipment category. Matches existing categories or creates a new one on the fly.'],
    ['• Color: Exterior instrument color / wood finish (e.g. Natural, Sunburst, Black).'],
    ['• HSN Code: Goods and Services Tax Harmonized System of Nomenclature code (defaults to 9202 for musical instruments).'],
    ['• Low Stock Alert: Minimum threshold count that triggers an executive inventory alert on your dashboard.'],
    ['• Unit of Measure: Stock unit (e.g. pcs, set, pair, unit). Defaults to pcs.'],
    ['• Purchase Cost: Standard cost price in INR (defaults to 0 if unknown; can be updated during delivery intake).'],
    ['• Selling Price: Standard retail selling price in INR.'],
    ['• Opening Stock: Initial stock quantity to populate into the system directly.'],
    ['• Serial Numbers: Comma-separated manufacturer serial numbers or barcodes.'],
    ['• Location Code: Outlet code where inventory is placed (e.g. CENTRAL).'],
  ];

  const wsInstructions = XLSX.utils.aoa_to_sheet(instructions);
  wsInstructions['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Flexible header normalisation for Excel spreadsheets.
 */
function normalizeKey(header: string): string {
  const clean = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^(brand|make|manufacturer)$/.test(clean)) return 'brand';
  if (/^(productname|name|title|itemname|product)$/.test(clean)) return 'name';
  if (/^(model|modelname|series|modelseries|seriesname|modelseriesname)$/.test(clean)) return 'modelName';
  if (/^(category|productcategory|categoryname|cat)$/.test(clean)) return 'category';
  if (/^(color|colour|finish)$/.test(clean)) return 'color';
  if (/^(hsn|hsncode|hsnsac|hsnno)$/.test(clean)) return 'hsnCode';
  if (/^(lowstock|lowstockalert|minstock|minstockthreshold|threshold|reorderlevel|alert)$/.test(clean)) return 'minStockThreshold';
  if (/^(unitofmeasure|unit|uom|unitofmeasurement|measure)$/.test(clean)) return 'unitOfMeasure';
  if (/^(purchasecost|cost|buyprice|costprice|purchaseprice|buyingcost)$/.test(clean)) return 'purchaseCost';
  if (/^(sellingprice|price|mrp|retailprice|saleprice|defaultsellingprice|retail)$/.test(clean)) return 'defaultSellingPrice';
  if (/^(trackingmode|tracking|serialized|serialtracking|isasset)$/.test(clean)) return 'trackingMode';
  if (/^(openingstock|stock|initialstock|quantity|qty|stockquantity|onhand|currentstock|pieces)$/.test(clean)) return 'openingStock';
  if (/^(serialnumbers|serials|serialnumber|serialnos|serialno|assetids|assetid|barcodes|barcode)$/.test(clean)) return 'serialNumbers';
  if (/^(location|locationcode|store|storecode|stocklocation)$/.test(clean)) return 'location';
  if (/^(sku|productcode|code|itemcode)$/.test(clean)) return 'sku';
  if (/^(description|desc|notes|details|specs)$/.test(clean)) return 'description';
  return clean;
}

/**
 * Parse an Excel file and import products directly into the database.
 */
export async function importProductCatalogFromExcel(
  fileBuffer: Buffer,
  actor: AuthenticatedUser
): Promise<ProductBulkImportResult> {
  const wb = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheetName =
    wb.SheetNames.find((s) => /product|catalog|item/i.test(s)) || wb.SheetNames[0];

  if (!sheetName) {
    throw new Error('The uploaded Excel file contains no valid sheets.');
  }

  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });

  if (!aoa || aoa.length < 2) {
    throw new Error('The spreadsheet is empty or missing data rows.');
  }

  // Row 0 is headers
  const rawHeaders = (aoa[0] as unknown[]).map((h) => String(h || '').trim());
  const headerKeys = rawHeaders.map((h) => normalizeKey(h));

  // Determine where data starts: if Row 1 has hints (e.g. contains "e.g." or "REQUIRED"), data starts at Row 2 (0-indexed)
  let dataStartIndex = 1;
  if (aoa.length > 2) {
    const row1Str = JSON.stringify(aoa[1]).toLowerCase();
    if (row1Str.includes('e.g.') || row1Str.includes('required') || row1Str.includes('hint') || row1Str.includes('default')) {
      dataStartIndex = 2;
    }
  }

  // Cache categories in memory for quick case-insensitive lookups
  const categoryCache = new Map<string, Types.ObjectId>();
  const existingCategories = await Category.find({}).lean();
  for (const c of existingCategories) {
    categoryCache.set(c.name.trim().toLowerCase(), c._id as Types.ObjectId);
  }

  // Find or create default location for initial stock record
  const defaultLoc =
    (await StockLocation.findOne({ isDefault: true })) ||
    (await StockLocation.findOne()) ||
    (await StockLocation.create({ name: 'Central Store', code: 'CENTRAL', isDefault: true }));

  const defaultLocationId = defaultLoc._id;

  const errors: ProductImportRowError[] = [];
  const importedProducts: ProductBulkImportResult['products'] = [];
  let skippedCount = 0;
  let totalInitialStockCreated = 0;

  // Track created SKUs during this batch to prevent internal collision
  const batchSkus = new Set<string>();

  for (let rowIndex = dataStartIndex; rowIndex < aoa.length; rowIndex++) {
    const row = aoa[rowIndex] as unknown[];
    const rowObj: Record<string, string> = {};

    headerKeys.forEach((key, colIdx) => {
      if (key) {
        rowObj[key] = String(row[colIdx] || '').trim();
      }
    });

    // Skip empty rows
    const hasValues = Object.values(rowObj).some((v) => v !== '');
    if (!hasValues) {
      skippedCount++;
      continue;
    }

    const excelRowNumber = rowIndex + 1; // 1-based index for human display

    // Required field validation: Product Name
    const name = rowObj.name;
    if (!name) {
      errors.push({
        row: excelRowNumber,
        field: 'Product Name',
        message: 'Product Name is required.',
      });
      continue;
    }

    // Category handling: Match or auto-create
    let categoryName = rowObj.category || 'General Instruments';
    categoryName = categoryName.trim();
    const catLower = categoryName.toLowerCase();
    let categoryId = categoryCache.get(catLower);

    if (!categoryId) {
      try {
        const newCat = await Category.create({
          name: categoryName,
          isActive: true,
        });
        categoryId = newCat._id as Types.ObjectId;
        categoryCache.set(catLower, categoryId);
      } catch (err: any) {
        // In case of race condition
        const existingCat = await Category.findOne({ name: new RegExp(`^${categoryName}$`, 'i') });
        if (existingCat) {
          categoryId = existingCat._id as Types.ObjectId;
          categoryCache.set(catLower, categoryId);
        } else {
          errors.push({
            row: excelRowNumber,
            field: 'Category',
            message: `Could not assign or create category "${categoryName}": ${err.message}`,
          });
          continue;
        }
      }
    }

    // SKU handling: User-specified or auto-generated
    let sku = rowObj.sku ? rowObj.sku.toUpperCase().trim() : '';
    if (!sku || sku === 'AUTO') {
      sku = await getNextSku();
      let candidateNum = parseInt(sku.replace(/\D/g, ''), 10) || 1;
      while (batchSkus.has(sku) || (await Product.findOne({ sku }))) {
        candidateNum++;
        sku = `SKU-${String(candidateNum).padStart(4, '0')}`;
      }
    } else {
      if (batchSkus.has(sku) || (await Product.findOne({ sku }))) {
        // If duplicate in sheet or DB, adjust with suffix rather than crashing the batch
        let candidateNum = 1;
        let altSku = `${sku}-${candidateNum}`;
        while (batchSkus.has(altSku) || (await Product.findOne({ sku: altSku }))) {
          candidateNum++;
          altSku = `${sku}-${candidateNum}`;
        }
        sku = altSku;
      }
    }

    batchSkus.add(sku);

    // Tracking mode parsing
    const rawTracking = (rowObj.trackingMode || '').toUpperCase().trim();
    const trackingMode: TrackingMode =
      rawTracking.includes('SERIAL') || rawTracking === 'YES' || rawTracking === 'TRUE'
        ? TRACKING_MODES.SERIALIZED
        : TRACKING_MODES.QUANTITY;

    const brand = rowObj.brand || 'Stereobliss';
    const color = rowObj.color || undefined;
    const modelName = rowObj.modelName || undefined;
    const hsnCode = rowObj.hsnCode || '9202';
    const unitOfMeasure = rowObj.unitOfMeasure || 'pcs';
    const minStockThreshold = Math.max(0, parseInt(rowObj.minStockThreshold, 10) || 5);
    const purchaseCost = Math.max(0, parseFloat(rowObj.purchaseCost) || 0);
    const defaultSellingPrice = Math.max(0, parseFloat(rowObj.defaultSellingPrice) || 0);
    const description = rowObj.description || undefined;

    // Location resolution: Target outlet code or name (fallback to default CENTRAL location)
    let targetLocId = defaultLocationId;
    const locInput = (rowObj.location || '').trim();
    if (locInput) {
      const foundLoc = await StockLocation.findOne({
        $or: [{ code: locInput.toUpperCase() }, { name: new RegExp(`^${locInput}$`, 'i') }],
      });
      if (foundLoc) targetLocId = foundLoc._id;
    }

    const rawOpening = parseInt(rowObj.openingStock, 10);
    const openingStock = isNaN(rawOpening) ? 0 : Math.max(0, rawOpening);

    try {
      const created = await Product.create({
        name,
        sku,
        brand,
        modelName,
        category: categoryId,
        color,
        hsnCode,
        unitOfMeasure,
        minStockThreshold,
        purchaseCost,
        defaultSellingPrice,
        trackingMode,
        description,
        isActive: true,
        stockQuantity: {
          onHand: 0,
          reserved: 0,
          issuedInternal: 0,
          quarantined: 0,
        },
        locationStock: [
          {
            location: targetLocId,
            onHand: 0,
            reserved: 0,
            issuedInternal: 0,
            quarantined: 0,
          },
        ],
      });

      let initialStockAdded = 0;

      // Handle opening stock for QUANTITY mode
      if (trackingMode === TRACKING_MODES.QUANTITY && openingStock > 0) {
        created.stockQuantity.onHand = openingStock;
        created.locationStock = [
          {
            location: targetLocId,
            onHand: openingStock,
            reserved: 0,
            issuedInternal: 0,
            quarantined: 0,
          },
        ];
        await created.save();

        await StockMovement.create({
          product: created._id,
          location: targetLocId,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: openingStock,
          transactionRef: `INITIAL-BALANCE-${created.sku}`,
          transactionModel: 'InitialBalance',
          reason: `Initial stock opening balance migrated from Excel catalog import (${created.name})`,
          performedBy: actor.id,
        });

        initialStockAdded = openingStock;
        totalInitialStockCreated += openingStock;
      }

      // Handle opening stock and serial numbers for SERIALIZED mode
      if (trackingMode === TRACKING_MODES.SERIALIZED) {
        const rawSerials = rowObj.serialNumbers
          ? rowObj.serialNumbers
              .split(/[,;\n]+/)
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)
          : [];

        const unitsToCreate = rawSerials.length > 0 ? rawSerials.length : openingStock;

        if (unitsToCreate > 0) {
          for (let i = 0; i < unitsToCreate; i++) {
            const mfrSerial = rawSerials[i] || undefined;
            let assetId = mfrSerial;
            if (!assetId || (await SerializedItem.findOne({ assetId }))) {
              let sub = i + 1;
              assetId = `${created.sku}-${String(sub).padStart(2, '0')}`;
              while (await SerializedItem.findOne({ assetId })) {
                sub++;
                assetId = `${created.sku}-${String(sub).padStart(2, '0')}`;
              }
            }

            const serialDoc = await SerializedItem.create({
              assetId,
              manufacturerSerial: mfrSerial,
              product: created._id,
              location: targetLocId,
              status: SERIALIZED_STATUSES.AVAILABLE,
              condition: ITEM_CONDITIONS.NEW,
              unitCost: created.purchaseCost || 0,
              notes: 'Migrated via Excel Product Catalog import',
            });

            await StockMovement.create({
              product: created._id,
              serializedItem: serialDoc._id,
              location: targetLocId,
              movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
              quantityDelta: 1,
              destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
              transactionRef: `ASSET-INIT-${assetId}`,
              transactionModel: 'InitialBalance',
              reason: `Initial asset ${assetId} intake via Excel catalog import`,
              performedBy: actor.id,
            });
          }

          created.stockQuantity.onHand = unitsToCreate;
          created.locationStock = [
            {
              location: targetLocId,
              onHand: unitsToCreate,
              reserved: 0,
              issuedInternal: 0,
              quarantined: 0,
            },
          ];
          await created.save();

          initialStockAdded = unitsToCreate;
          totalInitialStockCreated += unitsToCreate;
        }
      }

      importedProducts.push({
        _id: created._id.toString(),
        name: created.name,
        sku: created.sku,
        brand: created.brand,
        categoryName,
        color: created.color,
        hsnCode: created.hsnCode,
        unitOfMeasure: created.unitOfMeasure,
        minStockThreshold: created.minStockThreshold,
        initialStock: initialStockAdded,
      });
    } catch (err: any) {
      errors.push({
        row: excelRowNumber,
        field: 'Database',
        message: `Failed to insert product "${name}": ${err.message}`,
      });
    }
  }

  if (importedProducts.length > 0) {
    await logAudit({
      actor,
      action: 'BULK_IMPORT_PRODUCTS',
      entityType: 'Product',
      entityId: importedProducts[0]._id,
      reason: `Bulk imported ${importedProducts.length} product(s) with ${totalInitialStockCreated} initial stock units via Excel catalog spreadsheet`,
      afterState: {
        count: importedProducts.length,
        initialStockCreated: totalInitialStockCreated,
        skus: importedProducts.slice(0, 10).map((p) => p.sku),
      },
    });
  }

  return {
    success: errors.length === 0 || importedProducts.length > 0,
    totalRows: aoa.length - dataStartIndex,
    importedCount: importedProducts.length,
    skippedCount,
    initialStockCreated: totalInitialStockCreated,
    products: importedProducts,
    errors,
  };
}
