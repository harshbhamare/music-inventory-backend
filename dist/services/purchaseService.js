import { Types } from 'mongoose';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockLocation } from '../models/StockLocation.js';
import { Supplier } from '../models/Supplier.js';
import { PURCHASE_STATUSES, MOVEMENT_TYPES, } from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
export async function createPurchase(input, actor) {
    const purchaseCount = await Purchase.countDocuments();
    const year = new Date().getFullYear();
    const purchaseOrderNumber = `PO-${year}-${String(purchaseCount + 1).padStart(4, '0')}`;
    let subtotal = 0;
    const lineItems = input.lineItems.map((item) => {
        const totalCost = item.quantityOrdered * item.unitCost;
        subtotal += totalCost;
        return {
            product: new Types.ObjectId(item.product),
            quantityOrdered: item.quantityOrdered,
            quantityReceived: 0,
            unitCost: item.unitCost,
            totalCost,
        };
    });
    const additionalCosts = input.additionalCosts || 0;
    const totalCost = subtotal + additionalCosts;
    const purchase = await Purchase.create({
        purchaseOrderNumber,
        supplier: new Types.ObjectId(input.supplier),
        invoiceReference: input.invoiceReference,
        orderDate: input.orderDate ? new Date(input.orderDate) : new Date(),
        lineItems,
        subtotal,
        additionalCosts,
        totalCost,
        status: PURCHASE_STATUSES.CONFIRMED,
        destinationLocation: new Types.ObjectId(input.destinationLocation),
        notes: input.notes,
        createdBy: new Types.ObjectId(actor.id),
    });
    await logAudit({
        actor,
        action: 'CREATE_PURCHASE',
        entityType: 'Purchase',
        entityId: purchase._id.toString(),
        afterState: { purchaseOrderNumber, totalCost, lineItemsCount: lineItems.length },
        reason: 'Created purchase order',
    });
    return purchase;
}
export async function receivePurchase(purchaseId, input, actor) {
    // Idempotency check: prevent duplicate receipts
    if (input.idempotencyKey) {
        const existingReceipt = await PurchaseReceipt.findOne({ idempotencyKey: input.idempotencyKey });
        if (existingReceipt) {
            return existingReceipt;
        }
    }
    const purchase = await Purchase.findById(purchaseId);
    if (!purchase) {
        throw new AppError('Purchase order not found.', 404, 'NOT_FOUND');
    }
    if (purchase.status === PURCHASE_STATUSES.COMPLETED) {
        throw new AppError('This purchase order has already been fully received and completed.', 400, 'ALREADY_COMPLETED');
    }
    if (purchase.status === PURCHASE_STATUSES.CANCELLED) {
        throw new AppError('Cannot receive goods against a cancelled purchase order.', 400, 'ORDER_CANCELLED');
    }
    const locationId = new Types.ObjectId(input.destinationLocation);
    const location = await StockLocation.findById(locationId);
    if (!location || !location.isActive) {
        throw new AppError('Destination stock location is invalid or inactive.', 400, 'INVALID_LOCATION');
    }
    return await withTransaction(async (session) => {
        const receiptCount = await PurchaseReceipt.countDocuments();
        const year = new Date().getFullYear();
        const receiptNumber = `RCP-${year}-${String(receiptCount + 1).padStart(4, '0')}`;
        const receiptLineItems = [];
        for (let itemIdx = 0; itemIdx < input.lineItems.length; itemIdx++) {
            const itemInput = input.lineItems[itemIdx];
            const product = await Product.findById(itemInput.product).session(session || null);
            if (!product) {
                throw new AppError(`Product ${itemInput.product} not found.`, 404, 'PRODUCT_NOT_FOUND');
            }
            // Find matching line in purchase order:
            // 1. By explicit lineId if provided
            // 2. Or first line matching product that still has unreceived quantity
            // 3. Fallback to any line with this product for accurate error messaging
            let poLine = itemInput.lineId
                ? purchase.lineItems.find((l) => l._id?.toString() === itemInput.lineId)
                : null;
            if (!poLine) {
                poLine = purchase.lineItems.find((l) => l.product.toString() === itemInput.product.toString() &&
                    l.quantityReceived < l.quantityOrdered);
            }
            if (!poLine) {
                poLine = purchase.lineItems.find((l) => l.product.toString() === itemInput.product.toString());
            }
            if (!poLine) {
                throw new AppError(`Product ${product.name} is not on purchase order ${purchase.purchaseOrderNumber}.`, 400, 'LINE_NOT_FOUND');
            }
            const remainingExpected = poLine.quantityOrdered - poLine.quantityReceived;
            if (itemInput.quantityReceived > remainingExpected) {
                poLine.quantityOrdered = poLine.quantityReceived + itemInput.quantityReceived;
            }
            const serializedItemIds = [];
            // All products use quantity-based tracking. Treat any product still
            // flagged as SERIALIZED in the DB as QUANTITY — the startup migration
            // in server.ts / api/index.ts normalises the flag on cold start.
            // Quantity-based product intake
            await createStockMovement({
                product: product._id,
                location: locationId,
                movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
                quantityDelta: itemInput.quantityReceived,
                transactionRef: receiptNumber,
                transactionModel: 'PurchaseReceipt',
                reason: `Bulk stock intake against PO ${purchase.purchaseOrderNumber}`,
                performedBy: actor.id,
                idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${product._id}-${itemIdx}` : undefined,
            }, session);
            // Update product on-hand balance atomically
            product.stockQuantity.onHand += itemInput.quantityReceived;
            // Update location-level stock
            let locStock = product.locationStock.find((ls) => ls.location.toString() === locationId.toString());
            if (!locStock) {
                product.locationStock.push({
                    location: locationId,
                    onHand: itemInput.quantityReceived,
                    reserved: 0,
                    issuedInternal: 0,
                    quarantined: 0,
                });
            }
            else {
                locStock.onHand += itemInput.quantityReceived;
            }
            await product.save({ session });
            poLine.quantityReceived += itemInput.quantityReceived;
            receiptLineItems.push({
                product: product._id,
                quantityReceived: itemInput.quantityReceived,
                unitCost: itemInput.unitCost,
                serializedItemIds,
            });
        }
        // Check if PO is completed
        const allCompleted = purchase.lineItems.every((l) => l.quantityReceived >= l.quantityOrdered);
        purchase.status = allCompleted ? PURCHASE_STATUSES.COMPLETED : PURCHASE_STATUSES.PARTIALLY_RECEIVED;
        await purchase.save({ session });
        // Create receipt
        const receipt = new PurchaseReceipt({
            receiptNumber,
            purchase: purchase._id,
            receivedDate: new Date(),
            lineItems: receiptLineItems,
            destinationLocation: locationId,
            receivedBy: new Types.ObjectId(actor.id),
            notes: input.notes,
            idempotencyKey: input.idempotencyKey,
        });
        await receipt.save({ session });
        // Update purchaseReceipt reference on serialized items
        const allSerializedIds = receiptLineItems.flatMap((l) => l.serializedItemIds || []);
        if (allSerializedIds.length > 0) {
            await SerializedItem.updateMany({ _id: { $in: allSerializedIds } }, { $set: { purchaseReceipt: receipt._id } }, { session: session || undefined });
        }
        await logAudit({
            actor,
            action: 'RECEIVE_PURCHASE',
            entityType: 'PurchaseReceipt',
            entityId: receipt._id.toString(),
            afterState: { receiptNumber, itemsReceived: receiptLineItems.length },
            reason: `Received goods for PO ${purchase.purchaseOrderNumber}`,
        });
        return receipt;
    });
}
export async function quickReceiveStock(input, actor) {
    let locationId;
    if (input.destinationLocation) {
        locationId = new Types.ObjectId(input.destinationLocation);
    }
    else {
        const defaultLoc = (await StockLocation.findOne({ isDefault: true })) || (await StockLocation.findOne());
        if (!defaultLoc) {
            throw new AppError('No active stock location available.', 400, 'NO_LOCATION');
        }
        locationId = defaultLoc._id;
    }
    const supplierId = new Types.ObjectId(input.supplier);
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
    }
    return await withTransaction(async (session) => {
        const poCount = await Purchase.countDocuments();
        const year = new Date().getFullYear();
        const purchaseOrderNumber = `DIR-IN-${year}-${String(poCount + 1).padStart(4, '0')}`;
        const receiptNumber = `RCP-DIR-${year}-${String(poCount + 1).padStart(4, '0')}`;
        const poLines = [];
        const receiptLines = [];
        let totalAmount = 0;
        for (const itemInput of input.items) {
            const product = await Product.findById(itemInput.product).session(session || null);
            if (!product) {
                throw new AppError(`Product ${itemInput.product} not found.`, 404, 'PRODUCT_NOT_FOUND');
            }
            const qty = Math.max(1, itemInput.quantity);
            const unitCost = typeof itemInput.unitCost === 'number' ? itemInput.unitCost : product.purchaseCost;
            const lineTotalCost = unitCost * qty;
            totalAmount += lineTotalCost;
            poLines.push({
                product: product._id,
                quantityOrdered: qty,
                quantityReceived: qty,
                unitCost,
                totalCost: lineTotalCost,
            });
            const serializedItemIds = [];
            // All products are quantity-based in this system. If a product still has
            // trackingMode === SERIALIZED in the database (legacy data before the
            // server-startup migration guard), treat it as QUANTITY here rather than
            // crashing. The startup guard in server.ts / api/index.ts will normalize
            // it on the next cold start.
            //
            // We intentionally skip the SERIALIZED branch entirely so no SerializedItem
            // document is created, which avoids the "unitCost is required" Mongoose
            // validation error.
            await createStockMovement({
                product: product._id,
                location: locationId,
                movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
                quantityDelta: qty,
                sourceStatus: 'NONE',
                destinationStatus: 'AVAILABLE',
                transactionRef: receiptNumber,
                transactionModel: 'PurchaseReceipt',
                reason: `Direct Stock Intake (${purchaseOrderNumber}) from ${supplier.name}`,
                performedBy: actor.id,
            }, session);
            // Update Product Stock and Pricing
            if (typeof itemInput.unitCost === 'number' && itemInput.unitCost >= 0) {
                product.purchaseCost = itemInput.unitCost;
            }
            if (typeof itemInput.sellingPrice === 'number' && itemInput.sellingPrice >= 0) {
                product.defaultSellingPrice = itemInput.sellingPrice;
            }
            product.stockQuantity.onHand += qty;
            let locStock = product.locationStock.find((ls) => ls.location.toString() === locationId.toString());
            if (locStock) {
                locStock.onHand += qty;
            }
            else {
                product.locationStock.push({
                    location: locationId,
                    onHand: qty,
                    reserved: 0,
                    issuedInternal: 0,
                    quarantined: 0,
                });
            }
            await product.save({ session: session || undefined });
            receiptLines.push({
                product: product._id,
                quantityReceived: qty,
                unitCost,
                serializedItemIds,
            });
        }
        // Save Purchase
        const purchase = new Purchase({
            purchaseOrderNumber,
            supplier: supplier._id,
            destinationLocation: locationId,
            status: PURCHASE_STATUSES.COMPLETED,
            invoiceReference: input.invoiceReference?.trim() || undefined,
            lineItems: poLines,
            subtotal: totalAmount,
            additionalCosts: 0,
            totalCost: totalAmount,
            createdBy: new Types.ObjectId(actor.id),
            notes: input.notes,
        });
        await purchase.save({ session: session || undefined });
        // Save PurchaseReceipt
        const receipt = new PurchaseReceipt({
            receiptNumber,
            purchase: purchase._id,
            receivedDate: new Date(),
            lineItems: receiptLines,
            destinationLocation: locationId,
            receivedBy: new Types.ObjectId(actor.id),
            notes: input.notes,
        });
        await receipt.save({ session: session || undefined });
        // Link serialized items to receipt
        const allSerializedIds = receiptLines.flatMap((l) => l.serializedItemIds || []);
        if (allSerializedIds.length > 0) {
            await SerializedItem.updateMany({ _id: { $in: allSerializedIds } }, { $set: { purchaseReceipt: receipt._id } }, { session: session || undefined });
        }
        await logAudit({
            actor,
            action: 'DIRECT_STOCK_INTAKE',
            entityType: 'PurchaseReceipt',
            entityId: receipt._id.toString(),
            afterState: { receiptNumber, totalUnitsReceived: poLines.reduce((s, l) => s + l.quantityReceived, 0) },
            reason: `Direct Stock Intake from ${supplier.name}`,
        });
        return { purchase, receipt };
    });
}
