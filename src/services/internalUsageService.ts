import mongoose, { Types } from 'mongoose';
import { InternalUsage, IInternalUsage } from '../models/InternalUsage.js';
import { UsageReturn } from '../models/UsageReturn.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockLocation } from '../models/StockLocation.js';
import {
  USAGE_STATUSES,
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  ITEM_CONDITIONS,
  MOVEMENT_TYPES,
  UsagePurpose,
} from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
import { AuthenticatedUser } from '../middleware/auth.js';

export interface IssueInternalUsageInput {
  purpose: UsagePurpose;
  customPurposeDetail?: string;
  assignedPerson: string;
  assignedPersonContact?: string;
  customerEmail?: string;
  location: string;
  expectedReturnDate: string;
  notes?: string;
  isRental?: boolean;
  lockInPeriodMonths?: number;
  securityDeposit?: number;
  monthlyRent?: number;
  includedAccessories?: string[];
  items: Array<{
    product: string;
    quantityIssued: number;
    serializedItemId?: string;
    issueCondition?: string;
  }>;
}

export interface ReturnInternalUsageInput {
  notes?: string;
  items: Array<{
    product: string;
    quantityReturned: number;
    serializedItemId?: string;
    returnCondition: string;
    inspectionOutcome: 'OK_TO_STOCK' | 'NEEDS_MAINTENANCE' | 'QUARANTINE_DAMAGED';
    inspectionNotes?: string;
  }>;
}

export async function issueInstruments(input: IssueInternalUsageInput, actor: AuthenticatedUser) {
  const locationId = new Types.ObjectId(input.location);
  const location = await StockLocation.findById(locationId);
  if (!location || !location.isActive) {
    throw new AppError('Invalid or inactive location.', 400, 'INVALID_LOCATION');
  }

  const expectedReturnDate = new Date(input.expectedReturnDate);
  if (isNaN(expectedReturnDate.getTime()) || expectedReturnDate <= new Date()) {
    throw new AppError('Expected return date must be a valid future date and time.', 400, 'INVALID_RETURN_DATE');
  }

  return await withTransaction(async (session) => {
    const usageCount = await InternalUsage.countDocuments();
    const year = new Date().getFullYear();
    const issueReference = `USE-${year}-${String(usageCount + 1).padStart(5, '0')}`;

    const processedItems: any[] = [];

    for (const itemInput of input.items) {
      const product = await Product.findById(itemInput.product).session(session);
      if (!product || !product.isActive) {
        throw new AppError(`Product ${itemInput.product} is invalid or inactive.`, 400, 'INVALID_PRODUCT');
      }

      if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
        if (!itemInput.serializedItemId) {
          throw new AppError(`Serialized product ${product.name} requires a serialized asset selection.`, 400, 'ASSET_REQUIRED');
        }

        const serializedUnit = await SerializedItem.findOne({
          _id: new Types.ObjectId(itemInput.serializedItemId),
          product: product._id,
          location: locationId,
          status: SERIALIZED_STATUSES.AVAILABLE,
        }).session(session);

        if (!serializedUnit) {
          throw new AppError(
            `Serialized instrument ${itemInput.serializedItemId} is not currently AVAILABLE for internal issue.`,
            400,
            'ASSET_NOT_AVAILABLE'
          );
        }

        // Transition asset status to ISSUED_INTERNAL
        serializedUnit.status = SERIALIZED_STATUSES.ISSUED_INTERNAL;
        serializedUnit.assignedTo = input.assignedPerson.trim();
        await serializedUnit.save({ session });

        // Update product stock: onHand stays same, issuedInternal increments
        product.stockQuantity.issuedInternal += 1;
        let locStock = product.locationStock.find((ls) => ls.location.toString() === locationId.toString());
        if (locStock) {
          locStock.issuedInternal += 1;
        }
        await product.save({ session });

        // Immutable Stock Movement
        await createStockMovement(
          {
            product: product._id,
            serializedItem: serializedUnit._id,
            location: locationId,
            movementType: MOVEMENT_TYPES.INTERNAL_ISSUE,
            quantityDelta: 0, // Owned on-hand stock does not change, availability shifts
            sourceStatus: SERIALIZED_STATUSES.AVAILABLE,
            destinationStatus: SERIALIZED_STATUSES.ISSUED_INTERNAL,
            transactionRef: issueReference,
            transactionModel: 'InternalUsage',
            reason: `Issued to ${input.assignedPerson} for ${input.purpose}`,
            performedBy: actor.id,
          },
          session
        );

        processedItems.push({
          product: product._id,
          quantityIssued: 1,
          quantityReturned: 0,
          serializedItemId: serializedUnit._id,
          issueCondition: itemInput.issueCondition || serializedUnit.condition,
        });
      } else {
        // Quantity-based accessory/consumable issue
        const sq = product.stockQuantity;
        const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
        const available = (sq.onHand || 0) - unavailable;

        if (available < itemInput.quantityIssued) {
          throw new AppError(
            `Insufficient available quantity for ${product.name}. Available: ${available}, Requested: ${itemInput.quantityIssued}.`,
            400,
            'INSUFFICIENT_STOCK'
          );
        }

        product.stockQuantity.issuedInternal += itemInput.quantityIssued;
        let locStock = product.locationStock.find((ls) => ls.location.toString() === locationId.toString());
        if (locStock) {
          locStock.issuedInternal += itemInput.quantityIssued;
        }
        await product.save({ session });

        await createStockMovement(
          {
            product: product._id,
            location: locationId,
            movementType: MOVEMENT_TYPES.INTERNAL_ISSUE,
            quantityDelta: 0,
            transactionRef: issueReference,
            transactionModel: 'InternalUsage',
            reason: `Issued ${itemInput.quantityIssued}x to ${input.assignedPerson} for ${input.purpose}`,
            performedBy: actor.id,
          },
          session
        );

        processedItems.push({
          product: product._id,
          quantityIssued: itemInput.quantityIssued,
          quantityReturned: 0,
          issueCondition: itemInput.issueCondition || ITEM_CONDITIONS.GOOD,
        });
      }
    }

    const isRental = input.isRental !== false;
    const lockInPeriodMonths = Math.max(1, input.lockInPeriodMonths || 3);
    const securityDeposit = Math.max(0, input.securityDeposit || 0);
    const monthlyRent = Math.max(0, input.monthlyRent || 0);
    const includedAccessories = input.includedAccessories || [];

    const monthlyPayments: any[] = [];
    if (monthlyRent > 0) {
      const now = new Date();
      for (let m = 1; m <= lockInPeriodMonths; m++) {
        const dueDate = new Date(now);
        dueDate.setMonth(now.getMonth() + (m - 1));
        const monthName = dueDate.toLocaleString('default', { month: 'short', year: 'numeric' });
        monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m} (${monthName})`,
          dueDate,
          amountDue: monthlyRent,
          amountPaid: 0,
          status: 'DUE',
        });
      }
    }

    const totalRentDue = monthlyRent * lockInPeriodMonths;

    const usage = new InternalUsage({
      issueReference,
      purpose: input.purpose,
      customPurposeDetail: input.customPurposeDetail,
      assignedPerson: input.assignedPerson.trim(),
      assignedPersonContact: input.assignedPersonContact?.trim(),
      customerEmail: input.customerEmail?.trim().toLowerCase() || undefined,
      location: locationId,
      items: processedItems,
      issueDate: new Date(),
      expectedReturnDate,
      status: USAGE_STATUSES.ACTIVE,
      notes: input.notes,
      issuedBy: new Types.ObjectId(actor.id),
      isRental,
      lockInPeriodMonths,
      securityDeposit,
      monthlyRent,
      includedAccessories,
      monthlyPayments,
      totalRentPaid: 0,
      totalRentDue,
      remindersSent: [],
    });

    await usage.save({ session });

    // Link currentUsage on serialized items
    const serializedIds = processedItems
      .filter((i) => i.serializedItemId)
      .map((i) => i.serializedItemId);

    if (serializedIds.length > 0) {
      await SerializedItem.updateMany(
        { _id: { $in: serializedIds } },
        { $set: { currentUsage: usage._id } },
        { session: session || undefined }
      );
    }

    await logAudit({
      actor,
      action: 'ISSUE_INTERNAL_USAGE',
      entityType: 'InternalUsage',
      entityId: usage._id.toString(),
      afterState: { issueReference, assignedPerson: input.assignedPerson, purpose: input.purpose },
      reason: `Issued equipment for academy activity`,
    });

    return usage;
  });
}

export async function returnInstruments(
  usageId: string,
  input: ReturnInternalUsageInput,
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Internal usage record not found.', 404, 'NOT_FOUND');
  }

  if (usage.status === USAGE_STATUSES.RETURNED) {
    throw new AppError('This equipment issue has already been completely returned.', 400, 'ALREADY_RETURNED');
  }

  return await withTransaction(async (session) => {
    const returnCount = await UsageReturn.countDocuments();
    const year = new Date().getFullYear();
    const returnReference = `RET-USE-${year}-${String(returnCount + 1).padStart(5, '0')}`;

    const processedReturnItems: any[] = [];

    for (const returnInput of input.items) {
      const usageItem = usage.items.find(
        (i) =>
          i.product.toString() === returnInput.product.toString() &&
          (!returnInput.serializedItemId ||
            i.serializedItemId?.toString() === returnInput.serializedItemId.toString())
      );

      if (!usageItem) {
        throw new AppError(`Item was not found on this issue record.`, 400, 'ITEM_NOT_FOUND');
      }

      const remainingOutstanding = usageItem.quantityIssued - usageItem.quantityReturned;
      if (returnInput.quantityReturned > remainingOutstanding) {
        throw new AppError(
          `Returned quantity (${returnInput.quantityReturned}) cannot exceed remaining outstanding quantity (${remainingOutstanding}).`,
          400,
          'OVER_RETURN'
        );
      }

      const product = await Product.findById(returnInput.product).session(session);
      if (!product) throw new AppError('Product not found.', 404);

      if (product.trackingMode === TRACKING_MODES.SERIALIZED && returnInput.serializedItemId) {
        const serializedUnit = await SerializedItem.findById(returnInput.serializedItemId).session(session);
        if (!serializedUnit || serializedUnit.status !== SERIALIZED_STATUSES.ISSUED_INTERNAL) {
          throw new AppError(`Serialized asset ${returnInput.serializedItemId} is not currently in ISSUED_INTERNAL status.`, 400, 'INVALID_ASSET_STATUS');
        }

        // Apply inspection outcome
        let targetStatus: string = SERIALIZED_STATUSES.AVAILABLE;
        if (returnInput.inspectionOutcome === 'NEEDS_MAINTENANCE') {
          targetStatus = SERIALIZED_STATUSES.MAINTENANCE;
        } else if (returnInput.inspectionOutcome === 'QUARANTINE_DAMAGED') {
          targetStatus = SERIALIZED_STATUSES.QUARANTINED;
        }

        serializedUnit.status = targetStatus as any;
        serializedUnit.condition = returnInput.returnCondition as any;
        serializedUnit.currentUsage = undefined;
        serializedUnit.assignedTo = undefined;
        await serializedUnit.save({ session });

        // Update product balance counters
        product.stockQuantity.issuedInternal = Math.max(0, product.stockQuantity.issuedInternal - 1);
        if (targetStatus === SERIALIZED_STATUSES.QUARANTINED) {
          product.stockQuantity.quarantined += 1;
        }
        await product.save({ session });

        // Ledger entry
        await createStockMovement(
          {
            product: product._id,
            serializedItem: serializedUnit._id,
            location: usage.location,
            movementType: MOVEMENT_TYPES.INTERNAL_RETURN,
            quantityDelta: 0,
            sourceStatus: SERIALIZED_STATUSES.ISSUED_INTERNAL,
            destinationStatus: targetStatus,
            transactionRef: returnReference,
            transactionModel: 'UsageReturn',
            reason: `Return inspection outcome: ${returnInput.inspectionOutcome} (${returnInput.returnCondition})`,
            performedBy: actor.id,
          },
          session
        );
      } else {
        // Quantity-based return
        product.stockQuantity.issuedInternal = Math.max(
          0,
          product.stockQuantity.issuedInternal - returnInput.quantityReturned
        );
        if (returnInput.inspectionOutcome === 'QUARANTINE_DAMAGED') {
          product.stockQuantity.quarantined += returnInput.quantityReturned;
        }
        await product.save({ session });

        await createStockMovement(
          {
            product: product._id,
            location: usage.location,
            movementType: MOVEMENT_TYPES.INTERNAL_RETURN,
            quantityDelta: 0,
            transactionRef: returnReference,
            transactionModel: 'UsageReturn',
            reason: `Quantity item return inspection: ${returnInput.inspectionOutcome}`,
            performedBy: actor.id,
          },
          session
        );
      }

      usageItem.quantityReturned += returnInput.quantityReturned;

      processedReturnItems.push({
        product: product._id,
        quantityReturned: returnInput.quantityReturned,
        serializedItemId: returnInput.serializedItemId
          ? new Types.ObjectId(returnInput.serializedItemId)
          : undefined,
        returnCondition: returnInput.returnCondition,
        inspectionOutcome: returnInput.inspectionOutcome,
        inspectionNotes: returnInput.inspectionNotes,
      });
    }

    const allReturned = usage.items.every((i) => i.quantityReturned >= i.quantityIssued);
    usage.status = allReturned ? USAGE_STATUSES.RETURNED : USAGE_STATUSES.PARTIALLY_RETURNED;
    if (allReturned) {
      usage.actualReturnDate = new Date();
    }
    await usage.save({ session });

    const usageReturn = new UsageReturn({
      returnReference,
      internalUsage: usage._id,
      returnDate: new Date(),
      items: processedReturnItems,
      receivedBy: new Types.ObjectId(actor.id),
      notes: input.notes,
    });

    await usageReturn.save({ session });

    await logAudit({
      actor,
      action: 'RETURN_INTERNAL_USAGE',
      entityType: 'UsageReturn',
      entityId: usageReturn._id.toString(),
      afterState: { returnReference, usageReference: usage.issueReference, allReturned },
      reason: `Completed return inspection for issue ${usage.issueReference}`,
    });

    return usageReturn;
  });
}

export async function extendExpectedReturnDate(
  usageId: string,
  newDate: string,
  reason: string,
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Usage record not found.', 404, 'NOT_FOUND');
  }

  const parsedDate = new Date(newDate);
  if (isNaN(parsedDate.getTime()) || parsedDate <= usage.expectedReturnDate) {
    throw new AppError('New return date must be later than the current expected return date.', 400, 'INVALID_DATE');
  }

  usage.extensions.push({
    extendedDate: parsedDate,
    reason: reason.trim(),
    approvedBy: new Types.ObjectId(actor.id),
    createdAt: new Date(),
  });

  const previousDate = usage.expectedReturnDate;
  usage.expectedReturnDate = parsedDate;
  if (usage.status === USAGE_STATUSES.OVERDUE && parsedDate > new Date()) {
    usage.status = USAGE_STATUSES.ACTIVE;
  }

  await usage.save();

  await logAudit({
    actor,
    action: 'EXTEND_USAGE_RETURN_DATE',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    beforeState: { previousDate },
    afterState: { newDate: parsedDate, reason },
    reason: `Extended return deadline: ${reason}`,
  });

  return usage;
}

export async function recordRentalPayment(
  usageId: string,
  input: {
    amount: number;
    billingMonth?: string;
    paymentMethod?: string;
    transactionRef?: string;
    notes?: string;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  let payment = usage.monthlyPayments.find(
    (p) => input.billingMonth ? p.billingMonth === input.billingMonth : p.status !== 'PAID'
  );

  if (!payment) {
    const nextIndex = usage.monthlyPayments.length + 1;
    const now = new Date();
    const monthName = now.toLocaleString('default', { month: 'short', year: 'numeric' });
    usage.monthlyPayments.push({
      monthIndex: nextIndex,
      billingMonth: `Month ${nextIndex} (${monthName})`,
      dueDate: now,
      amountDue: input.amount,
      amountPaid: input.amount,
      paidAt: now,
      paymentMethod: input.paymentMethod || 'UPI',
      transactionRef: input.transactionRef,
      status: 'PAID',
      notes: input.notes,
    });
  } else {
    payment.amountPaid = (payment.amountPaid || 0) + input.amount;
    payment.paidAt = new Date();
    payment.paymentMethod = input.paymentMethod || 'UPI';
    payment.transactionRef = input.transactionRef || payment.transactionRef;
    payment.notes = input.notes || payment.notes;
    if (payment.amountPaid >= payment.amountDue) {
      payment.status = 'PAID';
    }
  }

  const totalPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  const totalDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );
  usage.totalRentPaid = totalPaid;
  usage.totalRentDue = totalDue;

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_PAYMENT_RECORDED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { totalPaid, totalDue, recordedAmount: input.amount },
    reason: `Recorded rent payment of ₹${input.amount} for ${usage.assignedPerson}`,
  });

  return usage;
}

export async function sendRentalReminder(usageId: string, actor: AuthenticatedUser) {
  const usage = await InternalUsage.findById(usageId).populate('items.product', 'name');
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  const recipient = usage.customerEmail || usage.assignedPersonContact || usage.assignedPerson;
  const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
  const pendingAmount = usage.totalRentDue > 0 ? usage.totalRentDue : usage.monthlyRent;

  const reminderMessage = `Dear ${usage.assignedPerson}, this is a payment reminder from StereoBliss Retail & Rentals. Your rental payment of ₹${pendingAmount} for "${prodName}" (Ref: ${usage.issueReference}) is due. Please pay via UPI/Card at your earliest convenience. Thank you!`;

  usage.remindersSent.push({
    sentAt: new Date(),
    sentTo: recipient,
    channel: usage.customerEmail ? 'EMAIL' : 'SMS',
    message: reminderMessage,
    sentBy: new Types.ObjectId(actor.id),
  });

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_REMINDER_SENT',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { recipient, pendingAmount },
    reason: `Dispatched payment reminder to ${recipient}`,
  });

  return {
    success: true,
    message: reminderMessage,
    sentTo: recipient,
    channel: usage.customerEmail ? 'EMAIL' : 'SMS',
    sentAt: new Date(),
    usage,
  };
}
