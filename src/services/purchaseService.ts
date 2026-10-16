import mongoose, { Types } from 'mongoose';
import { Purchase, IPurchase } from '../models/Purchase.js';
import { PurchaseReceipt, IPurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockLocation } from '../models/StockLocation.js';
import { Supplier } from '../models/Supplier.js';
import {
  PURCHASE_STATUSES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  ITEM_CONDITIONS,
  MOVEMENT_TYPES,
} from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
import { AuthenticatedUser } from '../middleware/auth.js';

export interface CreatePurchaseInput {
  supplier: string;
  invoiceReference?: string;
  orderDate?: string;
  destinationLocation: string;
  notes?: string;
  lineItems: Array<{
    product: string;
    quantityOrdered: number;
    unitCost: number;
  }>;
  additionalCosts?: number;
}

export interface ReceiveItemInput {
  lineId?: string;
  product: string;
  quantityReceived: number;
  unitCost: number;
  serializedUnits?: Array<{
    assetId?: string;
    manufacturerSerial?: string;
    condition?: string;
    warrantyExpiry?: string;
    notes?: string;
  }>;
}

export interface ReceivePurchaseInput {
  destinationLocation: string;
  notes?: string;
  idempotencyKey?: string;
  lineItems: ReceiveItemInput[];
}

export async function createPurchase(input: CreatePurchaseInput, actor: AuthenticatedUser) {
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

export async function receivePurchase(
  purchaseId: string,
  input: ReceivePurchaseInput,
  actor: AuthenticatedUser
) {
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

    const receiptLineItems: any[] = [];

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
        ? purchase.lineItems.find((l: any) => l._id?.toString() === itemInput.lineId)
        : null;

      if (!poLine) {
        poLine = purchase.lineItems.find(
          (l) =>
            l.product.toString() === itemInput.product.toString() &&
            l.quantityReceived < l.quantityOrdered
        );
      }

      if (!poLine) {
        poLine = purchase.lineItems.find(
          (l) => l.product.toString() === itemInput.product.toString()
        );
      }

      if (!poLine) {
        throw new AppError(`Product ${product.name} is not on purchase order ${purchase.purchaseOrderNumber}.`, 400, 'LINE_NOT_FOUND');
      }

      const remainingExpected = poLine.quantityOrdered - poLine.quantityReceived;
      if (itemInput.quantityReceived > remainingExpected) {
        poLine.quantityOrdered = poLine.quantityReceived + itemInput.quantityReceived;
      }

      const serializedItemIds: Types.ObjectId[] = [];

      if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
        const units = itemInput.serializedUnits || [];
        if (units.length !== itemInput.quantityReceived) {
          throw new AppError(
            `Product ${product.name} requires exactly ${itemInput.quantityReceived} serialized units, but ${units.length} provided.`,
            400,
            'SERIAL_COUNT_MISMATCH'
          );
        }

        for (let i = 0; i < units.length; i++) {
          const unit = units[i];
          let assetId = unit.assetId?.trim().toUpperCase();
          if (!assetId) {
            const count = await SerializedItem.countDocuments().session(session || null);
            const prefix = product.brand.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'MZI');
            assetId = `MZI-${prefix}-${String(count + i + 1).padStart(5, '0')}`;
          }

          // Check assetId uniqueness
          const existingAsset = await SerializedItem.findOne({ assetId }).session(session || null);
          if (existingAsset) {
            throw new AppError(`Asset ID ${assetId} already exists in the system.`, 409, 'DUPLICATE_ASSET_ID');
          }

          // Check manufacturer serial uniqueness if provided
          if (unit.manufacturerSerial) {
            const existingSerial = await SerializedItem.findOne({
              manufacturerSerial: unit.manufacturerSerial.trim().toUpperCase(),
            }).session(session || null);
            if (existingSerial) {
              throw new AppError(
                `Manufacturer Serial Number ${unit.manufacturerSerial} already exists in inventory.`,
                409,
                'DUPLICATE_SERIAL_NUMBER'
              );
            }
          }

          const serializedItem = new SerializedItem({
            assetId,
            manufacturerSerial: unit.manufacturerSerial?.trim().toUpperCase() || undefined,
            product: product._id,
            purchaseReceipt: undefined, // updated below
            unitCost: itemInput.unitCost,
            location: locationId,
            status: SERIALIZED_STATUSES.AVAILABLE,
            condition: unit.condition || ITEM_CONDITIONS.NEW,
            warrantyExpiry: unit.warrantyExpiry ? new Date(unit.warrantyExpiry) : undefined,
            notes: unit.notes,
          });

          await serializedItem.save({ session });
          serializedItemIds.push(serializedItem._id);

          // Record stock movement for serialized unit
          await createStockMovement(
            {
              product: product._id,
              serializedItem: serializedItem._id,
              location: locationId,
              movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
              quantityDelta: 1,
              sourceStatus: undefined,
              destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
              transactionRef: receiptNumber,
              transactionModel: 'PurchaseReceipt',
              reason: `Stock intake against PO ${purchase.purchaseOrderNumber}`,
              performedBy: actor.id,
              idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${assetId}` : undefined,
            },
            session
          );
        }
      } else {
        // Quantity-based product intake
        await createStockMovement(
          {
            product: product._id,
            location: locationId,
            movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
            quantityDelta: itemInput.quantityReceived,
            transactionRef: receiptNumber,
            transactionModel: 'PurchaseReceipt',
            reason: `Bulk stock intake against PO ${purchase.purchaseOrderNumber}`,
            performedBy: actor.id,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${product._id}-${itemIdx}` : undefined,
          },
          session
        );
      }

      // Update product on-hand balance atomically
      product.stockQuantity.onHand += itemInput.quantityReceived;

      // Update location-level stock
      let locStock = product.locationStock.find(
        (ls) => ls.location.toString() === locationId.toString()
      );
      if (!locStock) {
        product.locationStock.push({
          location: locationId,
          onHand: itemInput.quantityReceived,
          reserved: 0,
          issuedInternal: 0,
          quarantined: 0,
        });
      } else {
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
    const allCompleted = purchase.lineItems.every(
      (l) => l.quantityReceived >= l.quantityOrdered
    );
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
      await SerializedItem.updateMany(
        { _id: { $in: allSerializedIds } },
        { $set: { purchaseReceipt: receipt._id } },
        { session: session || undefined }
      );
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

export interface QuickReceiveInput {
  supplier: string;
  destinationLocation?: string;
  invoiceReference?: string;
  notes?: string;
  items: Array<{
    product: string;
    quantity: number;
    unitCost?: number;
    serializedUnits?: Array<{
      assetId?: string;
      manufacturerSerial?: string;
      condition?: string;
      warrantyExpiry?: string;
    }>;
  }>;
}

export async function quickReceiveStock(input: QuickReceiveInput, actor: AuthenticatedUser) {
  let locationId: Types.ObjectId;
  if (input.destinationLocation) {
    locationId = new Types.ObjectId(input.destinationLocation);
  } else {
    const defaultLoc = (await StockLocation.findOne({ isDefault: true })) || (await StockLocation.findOne());
    if (!defaultLoc) {
      throw new AppError('No active stock location available.', 400, 'NO_LOCATION');
    }
    locationId = defaultLoc._id as Types.ObjectId;
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

    const poLines: any[] = [];
    const receiptLines: any[] = [];
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

      const serializedItemIds: Types.ObjectId[] = [];

      if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
        const units = itemInput.serializedUnits || [];
        for (let i = 0; i < qty; i++) {
          const u = units[i] || {};
          let assetId = u.assetId?.trim().toUpperCase();
          if (!assetId) {
            const count = await SerializedItem.countDocuments().session(session || null);
            assetId = `${product.sku}-${year}-${String(count + i + 1).padStart(4, '0')}`;
          }

          const existingAsset = await SerializedItem.findOne({ assetId }).session(session || null);
          if (existingAsset) {
            assetId = `${assetId}-${Date.now().toString().slice(-4)}`;
          }

          const serializedItem = new SerializedItem({
            assetId,
            manufacturerSerial: u.manufacturerSerial?.trim() || undefined,
            product: product._id,
            location: locationId,
            status: SERIALIZED_STATUSES.AVAILABLE,
            condition: u.condition || ITEM_CONDITIONS.NEW,
            warrantyExpiry: u.warrantyExpiry ? new Date(u.warrantyExpiry) : undefined,
          });

          await serializedItem.save({ session: session || undefined });
          serializedItemIds.push(serializedItem._id as Types.ObjectId);

          await createStockMovement(
            {
              product: product._id,
              serializedItem: serializedItem._id,
              location: locationId,
              movementType: MOVEMENT_TYPES.PURCHASE_RECEIPT,
              quantityDelta: 1,
              sourceStatus: 'NONE',
              destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
              transactionRef: receiptNumber,
              transactionModel: 'PurchaseReceipt',
              reason: `Direct Stock Intake (${purchaseOrderNumber}) from ${supplier.name}`,
              performedBy: actor.id,
            },
            session
          );
        }
      } else {
        await createStockMovement(
          {
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
          },
          session
        );
      }

      // Update Product Stock
      product.stockQuantity.onHand += qty;
      let locStock = product.locationStock.find((ls: any) => ls.location.toString() === locationId.toString());
      if (locStock) {
        locStock.onHand += qty;
      } else {
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
      await SerializedItem.updateMany(
        { _id: { $in: allSerializedIds } },
        { $set: { purchaseReceipt: receipt._id } },
        { session: session || undefined }
      );
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
