import mongoose, { Types } from 'mongoose';
import { Sale, ISale } from '../models/Sale.js';
import { CustomerReturn } from '../models/CustomerReturn.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockLocation } from '../models/StockLocation.js';
import {
  SALE_STATUSES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  MOVEMENT_TYPES,
  ITEM_CONDITIONS,
} from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
import { AuthenticatedUser } from '../middleware/auth.js';

export interface CreateSaleInput {
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerGstin?: string;
  eWayBillNo?: string;
  dispatchThrough?: string;
  destination?: string;
  location: string;
  paymentMethod?: string;
  notes?: string;
  remarks?: string;
  idempotencyKey?: string;
  lineItems: Array<{
    product: string;
    quantity: number;
    unitPrice: number;
    discount?: number;
    hsnCode?: string;
    serializedItemIds?: string[];
  }>;
}

export interface ProcessSaleReturnInput {
  reason: string;
  items: Array<{
    product: string;
    quantity: number;
    serializedItemIds?: string[];
    condition: string;
    refundAmount: number;
    disposition: 'RETURN_TO_AVAILABLE' | 'QUARANTINE_INSPECTION' | 'MAINTENANCE';
  }>;
}

export async function createSale(input: CreateSaleInput, actor: AuthenticatedUser) {
  // Idempotency protection against duplicate submit
  if (input.idempotencyKey) {
    const existing = await Sale.findOne({ idempotencyKey: input.idempotencyKey });
    if (existing) {
      return existing;
    }
  }

  const locationId = new Types.ObjectId(input.location);
  const location = await StockLocation.findById(locationId);
  if (!location || !location.isActive) {
    throw new AppError('Invalid or inactive sale location.', 400, 'INVALID_LOCATION');
  }

  return await withTransaction(async (session) => {
    const salesCount = await Sale.countDocuments();
    const year = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(salesCount + 1).padStart(5, '0')}`;

    let subtotal = 0;
    let discountTotal = 0;
    const processedLineItems: any[] = [];

    for (const itemInput of input.lineItems) {
      const product = await Product.findById(itemInput.product).session(session);
      if (!product || !product.isActive) {
        throw new AppError(`Product ${itemInput.product} is invalid or inactive.`, 400, 'INVALID_PRODUCT');
      }

      const itemDiscount = (itemInput.discount || 0) * itemInput.quantity;
      const itemSubtotal = itemInput.unitPrice * itemInput.quantity;
      const itemTotal = Math.max(0, itemSubtotal - itemDiscount);

      subtotal += itemSubtotal;
      discountTotal += itemDiscount;

      if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
        const serialIds = itemInput.serializedItemIds || [];
        if (serialIds.length !== itemInput.quantity) {
          throw new AppError(
            `Must select exactly ${itemInput.quantity} serialized units for ${product.name}.`,
            400,
            'SERIAL_COUNT_MISMATCH'
          );
        }

        // Validate each serialized unit is currently AVAILABLE at this location
        for (const serialId of serialIds) {
          const serializedUnit = await SerializedItem.findOne({
            _id: new Types.ObjectId(serialId),
            product: product._id,
            location: locationId,
            status: SERIALIZED_STATUSES.AVAILABLE,
          }).session(session);

          if (!serializedUnit) {
            throw new AppError(
              `Serialized unit ${serialId} is not available for sale at this location.`,
              400,
              'ASSET_NOT_AVAILABLE'
            );
          }

          // Transition serialized asset state to SOLD
          serializedUnit.status = SERIALIZED_STATUSES.SOLD;
          await serializedUnit.save({ session });

          // Record individual serialized movement
          await createStockMovement(
            {
              product: product._id,
              serializedItem: serializedUnit._id,
              location: locationId,
              movementType: MOVEMENT_TYPES.SALE,
              quantityDelta: -1,
              sourceStatus: SERIALIZED_STATUSES.AVAILABLE,
              destinationStatus: SERIALIZED_STATUSES.SOLD,
              transactionRef: invoiceNumber,
              transactionModel: 'Sale',
              reason: `Sold to ${input.customerName}`,
              performedBy: actor.id,
              idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${serializedUnit.assetId}` : undefined,
            },
            session
          );
        }

        // Deduct from product onHand balance atomically
        // Notice conditional check: onHand >= quantity
        const updated = await Product.findOneAndUpdate(
          {
            _id: product._id,
            'stockQuantity.onHand': { $gte: itemInput.quantity },
          },
          {
            $inc: {
              'stockQuantity.onHand': -itemInput.quantity,
              'locationStock.$[elem].onHand': -itemInput.quantity,
            },
          },
          {
            session,
            new: true,
            arrayFilters: [{ 'elem.location': locationId }],
          }
        );

        if (!updated) {
          throw new AppError(
            `Insufficient stock for serialized product ${product.name}.`,
            400,
            'INSUFFICIENT_STOCK'
          );
        }
      } else {
        // Quantity-based stock: verify available stock
        const sq = product.stockQuantity;
        const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
        const available = (sq.onHand || 0) - unavailable;

        if (available < itemInput.quantity) {
          throw new AppError(
            `Insufficient available stock for ${product.name}. Available: ${available}, Requested: ${itemInput.quantity}.`,
            400,
            'INSUFFICIENT_STOCK'
          );
        }

        // Atomic conditional decrement to guarantee available stock >= 0
        const updated = await Product.findOneAndUpdate(
          {
            _id: product._id,
            'stockQuantity.onHand': { $gte: itemInput.quantity + unavailable },
          },
          {
            $inc: {
              'stockQuantity.onHand': -itemInput.quantity,
              'locationStock.$[elem].onHand': -itemInput.quantity,
            },
          },
          {
            session,
            new: true,
            arrayFilters: [{ 'elem.location': locationId }],
          }
        );

        if (!updated) {
          throw new AppError(
            `Concurrent sale conflict or insufficient stock for ${product.name}.`,
            400,
            'CONCURRENT_STOCK_CONFLICT'
          );
        }

        // Record stock movement
        await createStockMovement(
          {
            product: product._id,
            location: locationId,
            movementType: MOVEMENT_TYPES.SALE,
            quantityDelta: -itemInput.quantity,
            transactionRef: invoiceNumber,
            transactionModel: 'Sale',
            reason: `Retail sale to ${input.customerName}`,
            performedBy: actor.id,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${product._id}` : undefined,
          },
          session
        );
      }

      const itemHsn = itemInput.hsnCode || (product as any).hsnCode || '9202';
      const itemTaxable = itemTotal;
      const itemCgst = Math.round(itemTaxable * 0.09 * 100) / 100;
      const itemSgst = Math.round(itemTaxable * 0.09 * 100) / 100;

      processedLineItems.push({
        product: product._id,
        quantity: itemInput.quantity,
        unitPrice: itemInput.unitPrice,
        discount: itemInput.discount || 0,
        taxableAmount: itemTaxable,
        hsnCode: itemHsn,
        cgstAmount: itemCgst,
        sgstAmount: itemSgst,
        total: itemTotal,
        serializedItemIds: itemInput.serializedItemIds?.map((id) => new Types.ObjectId(id)),
      });
    }

    const taxableAmount = Math.max(0, subtotal - discountTotal);
    const cgstRate = 9;
    const sgstRate = 9;
    const cgstAmount = Math.round(taxableAmount * 0.09 * 100) / 100;
    const sgstAmount = Math.round(taxableAmount * 0.09 * 100) / 100;
    const taxTotal = Math.round((cgstAmount + sgstAmount) * 100) / 100;
    const grandTotal = Math.round((taxableAmount + taxTotal) * 100) / 100;

    const sale = new Sale({
      invoiceNumber,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail?.trim().toLowerCase() || undefined,
      customerPhone: input.customerPhone?.trim(),
      customerAddress: input.customerAddress?.trim(),
      customerGstin: input.customerGstin?.trim().toUpperCase(),
      eWayBillNo: input.eWayBillNo?.trim() || `28${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      dispatchThrough: input.dispatchThrough?.trim() || 'XP India',
      destination: input.destination?.trim() || 'PUNE',
      irn: `242b${Math.random().toString(16).substring(2, 10)}${Date.now().toString(16)}164dd9b476407904d`,
      ackNo: `1226${Math.floor(10000000000 + Math.random() * 90000000000)}`,
      ackDate: new Date(),
      location: locationId,
      lineItems: processedLineItems,
      subtotal,
      discountTotal,
      taxableAmount,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      taxTotal,
      grandTotal,
      paymentStatus: PAYMENT_STATUSES.PAID,
      paymentMethod: input.paymentMethod || PAYMENT_METHODS.UPI,
      saleStatus: SALE_STATUSES.CONFIRMED,
      notes: input.notes,
      remarks: input.remarks || input.notes,
      soldBy: new Types.ObjectId(actor.id),
      confirmedAt: new Date(),
      idempotencyKey: input.idempotencyKey,
    });

    await sale.save({ session });

    await logAudit({
      actor,
      action: 'RECORD_SALE',
      entityType: 'Sale',
      entityId: sale._id.toString(),
      afterState: { invoiceNumber, grandTotal, itemsCount: processedLineItems.length },
      reason: `Customer sale completed for ${input.customerName}`,
    });

    return sale;
  });
}

export async function processSaleReturn(
  saleId: string,
  input: ProcessSaleReturnInput,
  actor: AuthenticatedUser
) {
  const sale = await Sale.findById(saleId);
  if (!sale) {
    throw new AppError('Sale record not found.', 404, 'NOT_FOUND');
  }

  if (sale.saleStatus === SALE_STATUSES.CANCELLED) {
    throw new AppError('Cannot return items from an already cancelled sale.', 400, 'SALE_ALREADY_CANCELLED');
  }

  return await withTransaction(async (session) => {
    const returnCount = await CustomerReturn.countDocuments();
    const year = new Date().getFullYear();
    const returnReference = `RET-${year}-${String(returnCount + 1).padStart(4, '0')}`;

    let totalRefundAmount = 0;
    const processedReturnItems: any[] = [];

    for (const returnItem of input.items) {
      const originalLine = sale.lineItems.find(
        (l) => l.product.toString() === returnItem.product.toString()
      );
      if (!originalLine) {
        throw new AppError(`Product ${returnItem.product} was not part of sale ${sale.invoiceNumber}.`, 400, 'ITEM_NOT_IN_SALE');
      }

      if (returnItem.quantity > originalLine.quantity) {
        throw new AppError(
          `Return quantity (${returnItem.quantity}) cannot exceed original purchased quantity (${originalLine.quantity}).`,
          400,
          'INVALID_RETURN_QUANTITY'
        );
      }

      const product = await Product.findById(returnItem.product).session(session);
      if (!product) throw new AppError('Product not found.', 404);

      totalRefundAmount += returnItem.refundAmount || 0;

      if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
        const serialIds = returnItem.serializedItemIds || [];
        for (const sId of serialIds) {
          const serializedUnit = await SerializedItem.findById(sId).session(session);
          if (!serializedUnit || serializedUnit.status !== SERIALIZED_STATUSES.SOLD) {
            throw new AppError(`Serialized unit ${sId} is not in SOLD status.`, 400, 'INVALID_ASSET_STATUS');
          }

          let newStatus: string = SERIALIZED_STATUSES.QUARANTINED;
          if (returnItem.disposition === 'RETURN_TO_AVAILABLE') {
            newStatus = SERIALIZED_STATUSES.AVAILABLE;
          } else if (returnItem.disposition === 'MAINTENANCE') {
            newStatus = SERIALIZED_STATUSES.MAINTENANCE;
          }

          serializedUnit.status = newStatus as any;
          serializedUnit.condition = (returnItem.condition as any) || serializedUnit.condition;
          await serializedUnit.save({ session });

          await createStockMovement(
            {
              product: product._id,
              serializedItem: serializedUnit._id,
              location: sale.location,
              movementType: MOVEMENT_TYPES.SALE_RETURN,
              quantityDelta: 1,
              sourceStatus: SERIALIZED_STATUSES.SOLD,
              destinationStatus: newStatus,
              transactionRef: returnReference,
              transactionModel: 'CustomerReturn',
              reason: `Customer return: ${input.reason}`,
              performedBy: actor.id,
            },
            session
          );
        }

        // Return to onHand stock
        product.stockQuantity.onHand += returnItem.quantity;
        if (returnItem.disposition === 'QUARANTINE_INSPECTION') {
          product.stockQuantity.quarantined += returnItem.quantity;
        }

        await product.save({ session });
      } else {
        // Quantity-based return
        product.stockQuantity.onHand += returnItem.quantity;
        if (returnItem.disposition === 'QUARANTINE_INSPECTION') {
          product.stockQuantity.quarantined += returnItem.quantity;
        }

        await product.save({ session });

        await createStockMovement(
          {
            product: product._id,
            location: sale.location,
            movementType: MOVEMENT_TYPES.SALE_RETURN,
            quantityDelta: returnItem.quantity,
            transactionRef: returnReference,
            transactionModel: 'CustomerReturn',
            reason: `Customer return: ${input.reason}`,
            performedBy: actor.id,
          },
          session
        );
      }

      processedReturnItems.push({
        product: product._id,
        quantity: returnItem.quantity,
        serializedItemIds: returnItem.serializedItemIds?.map((id) => new Types.ObjectId(id)),
        condition: returnItem.condition,
        refundAmount: returnItem.refundAmount,
        disposition: returnItem.disposition,
      });
    }

    const customerReturn = new CustomerReturn({
      returnReference,
      originalSale: sale._id,
      returnedItems: processedReturnItems,
      totalRefundAmount,
      reason: input.reason,
      processedBy: new Types.ObjectId(actor.id),
    });

    await customerReturn.save({ session });

    sale.saleStatus = SALE_STATUSES.RETURNED;
    if (totalRefundAmount > 0) {
      sale.paymentStatus = PAYMENT_STATUSES.REFUNDED;
    }
    await sale.save({ session });

    await logAudit({
      actor,
      action: 'PROCESS_SALE_RETURN',
      entityType: 'CustomerReturn',
      entityId: customerReturn._id.toString(),
      afterState: { returnReference, totalRefundAmount },
      reason: `Processed customer return for invoice ${sale.invoiceNumber}: ${input.reason}`,
    });

    return customerReturn;
  });
}
