import * as XLSX from 'xlsx';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { StockLocation } from '../models/StockLocation.js';
import { TRACKING_MODES } from '../config/constants.js';
import { logAudit } from './auditService.js';
import { getNextSku } from './inventoryService.js';
/**
 * Generate a clean, sample-filled Excel template (.xlsx) for bulk product catalog intake.
 */
export function generateProductCatalogTemplate() {
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
        ['7. Upload the completed .xlsx file via Settings or Product Catalog page.'],
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
    ];
    const wsInstructions = XLSX.utils.aoa_to_sheet(instructions);
    wsInstructions['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/**
 * Flexible header normalisation for Excel spreadsheets.
 */
function normalizeKey(header) {
    const clean = header.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^(brand|make|manufacturer)$/.test(clean))
        return 'brand';
    if (/^(productname|name|title|itemname|product)$/.test(clean))
        return 'name';
    if (/^(model|modelname|series|modelseries|seriesname|modelseriesname)$/.test(clean))
        return 'modelName';
    if (/^(category|productcategory|categoryname|cat)$/.test(clean))
        return 'category';
    if (/^(color|colour|finish)$/.test(clean))
        return 'color';
    if (/^(hsn|hsncode|hsnsac|hsnno)$/.test(clean))
        return 'hsnCode';
    if (/^(lowstock|lowstockalert|minstock|minstockthreshold|threshold|reorderlevel)$/.test(clean))
        return 'minStockThreshold';
    if (/^(unitofmeasure|unit|uom|unitofmeasurement|measure)$/.test(clean))
        return 'unitOfMeasure';
    if (/^(purchasecost|cost|buyprice|costprice|purchaseprice)$/.test(clean))
        return 'purchaseCost';
    if (/^(sellingprice|price|mrp|retailprice|saleprice|defaultsellingprice)$/.test(clean))
        return 'defaultSellingPrice';
    if (/^(trackingmode|tracking|serialized|serialtracking)$/.test(clean))
        return 'trackingMode';
    if (/^(sku|productcode|code|itemcode)$/.test(clean))
        return 'sku';
    if (/^(description|desc|notes|details)$/.test(clean))
        return 'description';
    return clean;
}
/**
 * Parse an Excel file and import products directly into the database.
 */
export async function importProductCatalogFromExcel(fileBuffer, actor) {
    const wb = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((s) => /product|catalog|item/i.test(s)) || wb.SheetNames[0];
    if (!sheetName) {
        throw new Error('The uploaded Excel file contains no valid sheets.');
    }
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!aoa || aoa.length < 2) {
        throw new Error('The spreadsheet is empty or missing data rows.');
    }
    // Row 0 is headers
    const rawHeaders = aoa[0].map((h) => String(h || '').trim());
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
    const categoryCache = new Map();
    const existingCategories = await Category.find({}).lean();
    for (const c of existingCategories) {
        categoryCache.set(c.name.trim().toLowerCase(), c._id);
    }
    // Find or create default location for initial stock record
    const defaultLoc = (await StockLocation.findOne({ isDefault: true })) ||
        (await StockLocation.findOne()) ||
        (await StockLocation.create({ name: 'Central Store', code: 'CENTRAL', isDefault: true }));
    const defaultLocationId = defaultLoc._id;
    const errors = [];
    const importedProducts = [];
    let skippedCount = 0;
    // Track created SKUs during this batch to prevent internal collision
    const batchSkus = new Set();
    for (let rowIndex = dataStartIndex; rowIndex < aoa.length; rowIndex++) {
        const row = aoa[rowIndex];
        const rowObj = {};
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
                categoryId = newCat._id;
                categoryCache.set(catLower, categoryId);
            }
            catch (err) {
                // In case of race condition
                const existingCat = await Category.findOne({ name: new RegExp(`^${categoryName}$`, 'i') });
                if (existingCat) {
                    categoryId = existingCat._id;
                    categoryCache.set(catLower, categoryId);
                }
                else {
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
        }
        else {
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
        const trackingMode = rawTracking.includes('SERIAL') || rawTracking === 'YES' || rawTracking === 'TRUE'
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
                        location: defaultLocationId,
                        onHand: 0,
                        reserved: 0,
                        issuedInternal: 0,
                        quarantined: 0,
                    },
                ],
            });
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
            });
        }
        catch (err) {
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
            reason: `Bulk imported ${importedProducts.length} product(s) via Excel catalog spreadsheet`,
            afterState: {
                count: importedProducts.length,
                skus: importedProducts.slice(0, 10).map((p) => p.sku),
            },
        });
    }
    return {
        success: errors.length === 0 || importedProducts.length > 0,
        totalRows: aoa.length - dataStartIndex,
        importedCount: importedProducts.length,
        skippedCount,
        products: importedProducts,
        errors,
    };
}
