import mongoose, { Types } from 'mongoose';
import { InternalUsage, IInternalUsage } from '../models/InternalUsage.js';
import { Sale } from '../models/Sale.js';
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
import {
  sendRentalPaymentReminderEmail,
  sendRentalPaymentReceiptEmail,
  sendDepositDeductionNoticeEmail,
  sendRentalAgreementWelcomeEmail,
  sendDepositExhaustionEmail,
} from './emailService.js';

export interface IssueInternalUsageInput {
  purpose: UsagePurpose;
  customPurposeDetail?: string;
  assignedPerson: string;
  assignedPersonContact?: string;
  customerEmail?: string;
  location: string;
  expectedReturnDate: string;
  startDate?: string;
  issueDate?: string;
  notes?: string;
  isRental?: boolean;
  lockInPeriodMonths?: number;
  securityDeposit?: number;
  depositTransactionRef?: string;     // mandatory when securityDeposit > 0
  depositMode?: boolean;               // true = auto-deduct rent from deposit each month
  depositPaymentMethod?: string;       // how deposit was paid (CASH/UPI/CARD/BANK_TRANSFER)
  monthlyRent?: number;
  includedAccessories?: string[];
  items: Array<{
    product: string;
    quantityIssued: number;
    serializedItemId?: string;
    issueCondition?: string;
  }>;
}

export function addMonthsPreservingDay(baseDate: Date | string, monthsToAdd: number): Date {
  const d = new Date(baseDate);
  const targetYear = d.getFullYear();
  const targetMonth = d.getMonth() + monthsToAdd;
  const targetDay = d.getDate();
  const maxDaysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(
    targetYear,
    targetMonth,
    Math.min(targetDay, maxDaysInTargetMonth),
    d.getHours() || 18,
    d.getMinutes() || 0,
    0
  );
}

export interface ReturnInternalUsageInput {
  notes?: string;
  customerEmail?: string;
  sendReceiptEmail?: boolean;
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
    let firstProductName = 'Musical Instrument';

    for (const itemInput of input.items) {
      const product = await Product.findById(itemInput.product).session(session);
      if (!product || !product.isActive) {
        throw new AppError(`Product ${itemInput.product} is invalid or inactive.`, 400, 'INVALID_PRODUCT');
      }
      if (firstProductName === 'Musical Instrument' && product.name) {
        firstProductName = product.name;
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

    // Deposit mode: rent is deducted from the security deposit each month instead of collected separately
    const depositMode = !!(input.depositMode && securityDeposit > 0 && monthlyRent > 0);
    const depositTransactionRef = input.depositTransactionRef?.trim() || '';

    // Mandatory: if deposit > 0 a transaction reference must be provided
    if (securityDeposit > 0 && !depositTransactionRef) {
      throw new AppError(
        'Transaction reference number is mandatory when collecting a security deposit.',
        400,
        'DEPOSIT_TXN_REF_REQUIRED'
      );
    }

    // In deposit mode monthly payments are pre-marked as covered by deposit (amountDue = 0 from customer)
    const baseDate = input.startDate || input.issueDate ? new Date(input.startDate || input.issueDate!) : new Date();
    const monthlyPayments: any[] = [];
    if (monthlyRent > 0) {
      for (let m = 1; m <= lockInPeriodMonths; m++) {
        const dueDate = addMonthsPreservingDay(baseDate, m);
        const monthName = dueDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
        monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m} (${monthName})`,
          dueDate,
          amountDue: monthlyRent,
          amountPaid: 0,
          status: 'DUE',
          notes: depositMode ? 'Covered by security deposit — awaiting monthly deduction' : undefined,
        });
      }
    }

    // In deposit mode total rent is covered by deposit; customer owes nothing additional upfront
    const totalRentDue = depositMode ? 0 : monthlyRent * lockInPeriodMonths;

    const usage = new InternalUsage({
      issueReference,
      purpose: input.purpose,
      customPurposeDetail: input.customPurposeDetail,
      assignedPerson: input.assignedPerson.trim(),
      assignedPersonContact: input.assignedPersonContact?.trim(),
      customerEmail: input.customerEmail?.trim().toLowerCase() || undefined,
      location: locationId,
      items: processedItems,
      issueDate: baseDate,
      expectedReturnDate,
      status: USAGE_STATUSES.ACTIVE,
      notes: input.notes,
      issuedBy: new Types.ObjectId(actor.id),
      isRental,
      lockInPeriodMonths,
      securityDeposit,
      depositTransactionRef,
      depositMode,
      depositBalance: securityDeposit,   // starts as full deposit
      depositExhausted: false,
      depositDeductions: [],
      monthlyRent,
      includedAccessories,
      monthlyPayments,
      totalRentPaid: 0,
      totalRentDue,
      remindersSent: [],
      paymentLogs:
        securityDeposit > 0
          ? [
              {
                paymentType: 'SECURITY_DEPOSIT',
                amount: securityDeposit,
                paymentMethod: input.depositPaymentMethod || 'CASH',
                transactionRef: depositTransactionRef,
                billingMonth: 'Security Deposit',
                notes: `Refundable security deposit collected at rental handover. Txn: ${depositTransactionRef}`,
                recordedBy: new Types.ObjectId(actor.id),
                paidAt: new Date(),
              },
            ]
          : [],
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
      reason: `Issued equipment for rental / internal activity`,
    });

    // Send welcome / agreement confirmation email to customer (fire-and-forget, outside transaction)
    if (input.customerEmail?.trim() && input.customerEmail.includes('@')) {
      const productName = firstProductName;
      setImmediate(async () => {
        try {
          await sendRentalAgreementWelcomeEmail({
            recipientEmail: input.customerEmail!.trim().toLowerCase(),
            customerName: input.assignedPerson.trim(),
            customerContact: input.assignedPersonContact?.trim(),
            issueReference,
            productName,
            monthlyRent,
            securityDeposit,
            depositTransactionRef,
            depositMode,
            lockInPeriodMonths,
            expectedReturnDate: input.expectedReturnDate,
            includedAccessories,
          });
        } catch (emailErr) {
          console.error('[EMAIL_WELCOME_ERROR] Failed to send rental agreement welcome email:', emailErr);
        }
      });
    }

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

  if (input.customerEmail && input.customerEmail.trim().includes('@')) {
    usage.customerEmail = input.customerEmail.trim().toLowerCase();
  }

  const result = await withTransaction(async (session) => {
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
      if ((usage.depositBalance ?? 0) > 0) {
        usage.depositRefundStatus = 'REFUND_PENDING';
      } else {
        usage.depositRefundStatus = 'REFUNDED';
      }
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

  // Automatically dispatch Equipment Return Confirmation email to customer
  let emailSent = false;
  let deliveryLog: any = null;
  const targetEmail = (input.customerEmail || usage.customerEmail || '').trim().toLowerCase();

  if (input.sendReceiptEmail !== false && targetEmail && targetEmail.includes('@')) {
    try {
      const { sendRentalReturnConfirmationEmail } = await import('./emailService.js');
      const populatedUsage = await InternalUsage.findById(usage._id)
        .populate('items.product', 'name sku brand')
        .populate('items.serializedItemId', 'assetId manufacturerSerial');

      const prodName = (populatedUsage?.items[0]?.product as any)?.name || 'Musical Instrument';
      const assetId =
        (populatedUsage?.items[0]?.serializedItemId as any)?.assetId ||
        (populatedUsage?.items[0]?.serializedItemId as any)?.manufacturerSerial;
      const returnItem = input.items[0];

      deliveryLog = await sendRentalReturnConfirmationEmail({
        recipientEmail: targetEmail,
        customerName: usage.assignedPerson,
        customerContact: usage.assignedPersonContact,
        issueReference: usage.issueReference,
        returnReference: result.returnReference,
        productName: prodName,
        assetId,
        returnDate: new Date(),
        returnedItemsCount: input.items.reduce((acc, it) => acc + (it.quantityReturned || 1), 0),
        returnCondition: returnItem?.returnCondition || 'GOOD',
        inspectionOutcome: returnItem?.inspectionOutcome || 'AVAILABLE',
        depositBalance: usage.depositBalance || 0,
        depositRefundStatus: usage.depositRefundStatus || 'REFUNDED',
        totalRentPaid: usage.totalRentPaid || 0,
        totalMonthsRented: usage.monthlyPayments?.length || 1,
        receivedBy: { name: actor.name, email: actor.email, role: actor.role },
        notes: input.notes,
      });
      emailSent = !!deliveryLog;
    } catch (emailErr) {
      console.error('[EMAIL_RETURN_CONFIRMATION_ERROR] Failed to send return confirmation email:', emailErr);
    }
  }

  return {
    return: result,
    usage,
    emailSent,
    recipient: targetEmail || undefined,
    provider: deliveryLog?.provider || (emailSent ? 'EMAIL' : undefined),
    message: emailSent
      ? `Equipment return completed & receipt email dispatched to ${targetEmail}`
      : `Equipment returned to inventory successfully`,
  };
}

export async function extendExpectedReturnDate(
  usageId: string,
  newDate: string,
  reason: string,
  actor: AuthenticatedUser,
  options?: { addRentalMonths?: boolean }
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('location', 'name code')
    .populate('items.product', 'name sku brand trackingMode color')
    .populate('items.serializedItemId', 'assetId manufacturerSerial condition status');

  if (!usage) {
    throw new AppError('Usage record not found.', 404, 'NOT_FOUND');
  }

  const parsedDate = new Date(newDate);
  if (isNaN(parsedDate.getTime())) {
    throw new AppError('Invalid date format provided for return extension.', 400, 'INVALID_DATE');
  }

  const currentExpected = new Date(usage.expectedReturnDate);
  if (parsedDate <= currentExpected) {
    throw new AppError(
      `New return date (${parsedDate.toLocaleDateString()}) must be later than the current return deadline (${currentExpected.toLocaleDateString()}).`,
      400,
      'INVALID_DATE'
    );
  }

  if (!usage.extensions) usage.extensions = [];
  usage.extensions.push({
    extendedDate: parsedDate,
    reason: (reason || 'Extended return deadline').trim(),
    approvedBy: new Types.ObjectId(actor.id),
    createdAt: new Date(),
  });

  const previousDate = usage.expectedReturnDate;
  usage.expectedReturnDate = parsedDate;
  if (usage.status === USAGE_STATUSES.OVERDUE && parsedDate > new Date()) {
    usage.status = USAGE_STATUSES.ACTIVE;
  }

  // If this is a rental agreement and extension spans additional months, extend payment schedule
  if (usage.isRental && (usage.monthlyRent || 0) > 0 && options?.addRentalMonths !== false) {
    const baseDate = usage.issueDate ? new Date(usage.issueDate) : new Date();
    const diffMonths =
      (parsedDate.getFullYear() - baseDate.getFullYear()) * 12 +
      (parsedDate.getMonth() - baseDate.getMonth());
    const targetMonths = Math.max(usage.lockInPeriodMonths || 1, diffMonths);

    if (targetMonths > (usage.monthlyPayments || []).length) {
      const currentCount = (usage.monthlyPayments || []).length;
      const additionalMonths = targetMonths - currentCount;

      for (let i = 1; i <= additionalMonths; i++) {
        const m = currentCount + i;
        const dueDate = addMonthsPreservingDay(baseDate, m);
        const monthName = dueDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
        usage.monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m} (${monthName})`,
          dueDate,
          amountDue: usage.monthlyRent || 0,
          amountPaid: 0,
          status: 'DUE',
        });
      }

      usage.lockInPeriodMonths = targetMonths;
      usage.totalRentDue = (usage.monthlyPayments || []).reduce(
        (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
        0
      );
      usage.markModified('monthlyPayments');
    }
  }

  usage.markModified('extensions');
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
    billingMonth?: string;
    paymentId?: string;
    monthIndex?: number;
    amount: number;
    paymentMethod?: string;
    transactionRef?: string;
    notes?: string;
    adjustNextMonth?: boolean;
    customerEmail?: string;
    sendReceiptEmail?: boolean;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  let payment: any = null;
  if (input.paymentId) {
    payment = usage.monthlyPayments.find(
      (p) => p._id?.toString() === input.paymentId || (p as any).id === input.paymentId
    );
  } else if (input.monthIndex) {
    payment = usage.monthlyPayments.find((p) => p.monthIndex === input.monthIndex);
  } else if (input.billingMonth) {
    payment = usage.monthlyPayments.find((p) => p.billingMonth === input.billingMonth);
  } else {
    payment = usage.monthlyPayments.find((p) => p.status !== 'PAID');
  }

  if (payment) {
    // If user clicked confirm payment on an already PAID month (e.g. repeated clicks):
    if (payment.status === 'PAID' && (payment.amountPaid || 0) >= payment.amountDue) {
      throw new AppError(
        `Payment for ${payment.billingMonth} is already recorded as PAID (₹${payment.amountPaid}). Use the Edit button on this month to modify payment details.`,
        400,
        'PAYMENT_ALREADY_RECORDED'
      );
    }

    // Enforce mandatory transaction reference for all rent payments
    if (!input.transactionRef || !input.transactionRef.trim()) {
      throw new AppError(
        'Transaction reference number is mandatory for all rent payments. Please provide the UPI ref, cash receipt no., or bank transfer ref.',
        400,
        'TXN_REF_REQUIRED'
      );
    }

    // Allocate payment sequentially across unpaid months (allows paying multiple months or directly at once)
    let remainingPaymentToAllocate = input.amount;
    const unpaidPayments = usage.monthlyPayments.filter((p) => p.status !== 'PAID');
    const targetList = payment && !unpaidPayments.includes(payment)
      ? [payment, ...unpaidPayments]
      : (payment ? [payment, ...unpaidPayments.filter((p) => p !== payment)] : unpaidPayments);

    for (const p of targetList) {
      if (remainingPaymentToAllocate <= 0) break;
      const currentUnpaidOnMonth = Math.max(0, p.amountDue - (p.amountPaid || 0));
      const payThisMonth = Math.min(remainingPaymentToAllocate, currentUnpaidOnMonth);
      p.amountPaid = (p.amountPaid || 0) + payThisMonth;
      p.paidAt = new Date();
      p.paymentMethod = input.paymentMethod || 'UPI';
      p.transactionRef = input.transactionRef?.trim() || p.transactionRef;
      p.notes = input.notes?.trim() || p.notes;
      if (p.amountPaid >= p.amountDue) {
        p.status = 'PAID';
      }
      remainingPaymentToAllocate -= payThisMonth;
    }

    // If extra amount remains beyond all scheduled dues, credit it to the target payment
    if (remainingPaymentToAllocate > 0 && payment) {
      payment.amountPaid = (payment.amountPaid || 0) + remainingPaymentToAllocate;
    }
  } else {
    // No target month was found. If no month was specified and all months are paid, DO NOT silently append duplicate months!
    if (!input.billingMonth && !input.monthIndex && !input.paymentId) {
      throw new AppError(
        'All scheduled rental months are already fully paid. Use "Add Rental Month" to extend the rental agreement.',
        400,
        'ALL_MONTHS_ALREADY_PAID'
      );
    }

    const nextIndex =
      (usage.monthlyPayments.length > 0
        ? Math.max(...usage.monthlyPayments.map((p) => p.monthIndex))
        : 0) + 1;
    const now = new Date();
    const monthName = now.toLocaleString('default', { month: 'short', year: 'numeric' });
    payment = {
      monthIndex: nextIndex,
      billingMonth: input.billingMonth || `Month ${nextIndex} (${monthName})`,
      dueDate: now,
      amountDue: input.amount,
      amountPaid: input.amount,
      paidAt: now,
      paymentMethod: input.paymentMethod || 'UPI',
      transactionRef: input.transactionRef?.trim(),
      status: 'PAID',
      notes: input.notes?.trim(),
    };
    usage.monthlyPayments.push(payment);
  }

  // Adjust next month rent if requested
  if (input.adjustNextMonth && payment) {
    const difference = payment.amountDue - payment.amountPaid;
    const nextPayment = usage.monthlyPayments.find((p) => p.monthIndex === payment.monthIndex + 1);
    if (nextPayment) {
      nextPayment.amountDue = Math.max(0, nextPayment.amountDue + difference);
      const diffText = difference > 0 ? `+₹${difference}` : `-₹${Math.abs(difference)}`;
      nextPayment.notes = `${nextPayment.notes ? nextPayment.notes + ' | ' : ''}Adjusted ${diffText} from ${payment.billingMonth} balance`;
    }
  }

  const totalPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  const totalDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );
  usage.totalRentPaid = totalPaid;
  usage.totalRentDue = totalDue;

  if (!usage.paymentLogs) (usage as any).paymentLogs = [];
  (usage as any).paymentLogs.push({
    paymentType: 'RENTAL_PAYMENT',
    amount: payment.amountPaid,
    paymentMethod: payment.paymentMethod || 'UPI',
    transactionRef: payment.transactionRef || 'N/A',
    billingMonth: payment.billingMonth,
    notes: payment.notes,
    recordedBy: new Types.ObjectId(actor.id),
    paidAt: payment.paidAt || new Date(),
  });

  if (input.customerEmail && input.customerEmail.trim().includes('@')) {
    usage.customerEmail = input.customerEmail.trim().toLowerCase();
  }

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_PAYMENT_RECORDED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { totalPaid, totalDue, recordedAmount: input.amount, month: payment.billingMonth },
    reason: `Recorded rent payment of ₹${input.amount} for ${usage.assignedPerson} (${payment.billingMonth})`,
  });

  // Dispatch payment confirmation and receipt email for accountability
  let emailSent = false;
  let deliveryLog: any = null;
  const targetEmail = (input.customerEmail || usage.customerEmail || '').trim().toLowerCase();

  if (input.sendReceiptEmail !== false && payment.amountPaid > 0 && targetEmail && targetEmail.includes('@')) {
    try {
      await usage.populate('items.product', 'name');
      await usage.populate('items.serializedItemId', 'assetId manufacturerSerial');
      const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
      const assetId =
        (usage.items[0]?.serializedItemId as any)?.assetId ||
        (usage.items[0]?.serializedItemId as any)?.manufacturerSerial;
      const nextPayment = usage.monthlyPayments.find((p) => p.status !== 'PAID');

      deliveryLog = await sendRentalPaymentReceiptEmail({
        recipientEmail: targetEmail,
        customerName: usage.assignedPerson,
        customerContact: usage.assignedPersonContact,
        issueReference: usage.issueReference,
        productName: prodName,
        assetId,
        amountPaid: payment.amountPaid,
        amountDue: payment.amountDue,
        paymentMethod: payment.paymentMethod || 'UPI',
        transactionRef: payment.transactionRef,
        billingMonth: payment.billingMonth,
        paidAt: payment.paidAt || new Date(),
        totalRentPaid: usage.totalRentPaid,
        totalRentDue: usage.totalRentDue,
        nextDueDate: nextPayment?.dueDate,
        recordedBy: { name: actor.name, email: actor.email, role: actor.role },
        notes: payment.notes,
      });
      emailSent = !!deliveryLog;
    } catch (emailErr) {
      console.error('[EMAIL_RECEIPT_ERROR] Failed to dispatch receipt email:', emailErr);
    }
  }

  return {
    usage,
    emailSent,
    recipient: targetEmail || undefined,
    provider: deliveryLog?.provider || (emailSent ? 'EMAIL' : undefined),
    message: emailSent
      ? `Rent payment recorded & receipt email dispatched to ${targetEmail}`
      : `Rent payment of ₹${input.amount} recorded successfully`,
  };
}

export async function updateRentalPayment(
  usageId: string,
  paymentId: string,
  input: {
    amountPaid?: number;
    amountDue?: number;
    transactionRef?: string;
    paymentMethod?: string;
    notes?: string;
    paidAt?: string;
    adjustNextMonth?: boolean;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  const payment = usage.monthlyPayments.find(
    (p) => p._id?.toString() === paymentId || (p as any).id === paymentId
  );
  if (!payment) {
    throw new AppError('Rental payment entry not found.', 404, 'PAYMENT_NOT_FOUND');
  }

  if (input.amountDue !== undefined) {
    payment.amountDue = Math.max(0, input.amountDue);
  }
  if (input.amountPaid !== undefined) {
    payment.amountPaid = Math.max(0, input.amountPaid);
  }
  if (input.transactionRef !== undefined) {
    payment.transactionRef = input.transactionRef.trim() || undefined;
  }
  if (input.paymentMethod !== undefined) {
    payment.paymentMethod = input.paymentMethod;
  }
  if (input.notes !== undefined) {
    payment.notes = input.notes.trim() || undefined;
  }
  if (input.paidAt !== undefined) {
    payment.paidAt = input.paidAt ? new Date(input.paidAt) : undefined;
  } else if (payment.amountPaid > 0 && !payment.paidAt) {
    payment.paidAt = new Date();
  }

  // Update status
  if (payment.amountPaid >= payment.amountDue && payment.amountDue > 0) {
    payment.status = 'PAID';
  } else {
    payment.status = 'DUE';
  }

  // Adjust next month rent if requested
  if (input.adjustNextMonth) {
    const difference = payment.amountDue - payment.amountPaid;
    const nextPayment = usage.monthlyPayments.find((p) => p.monthIndex === payment.monthIndex + 1);
    if (nextPayment) {
      nextPayment.amountDue = Math.max(0, nextPayment.amountDue + difference);
      const diffText = difference > 0 ? `+₹${difference}` : `-₹${Math.abs(difference)}`;
      nextPayment.notes = `${nextPayment.notes ? nextPayment.notes + ' | ' : ''}Adjusted ${diffText} from ${payment.billingMonth} adjustment`;
    }
  }

  // Recalculate totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_PAYMENT_UPDATED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: {
      paymentId,
      billingMonth: payment.billingMonth,
      amountPaid: payment.amountPaid,
      amountDue: payment.amountDue,
      transactionRef: payment.transactionRef,
      totalRentPaid: usage.totalRentPaid,
      totalRentDue: usage.totalRentDue,
    },
    reason: `Updated payment details for ${payment.billingMonth} (₹${payment.amountPaid}, Trn: ${payment.transactionRef || 'N/A'})`,
  });

  // If payment was recorded/updated with amountPaid > 0, send receipt
  if (
    input.amountPaid !== undefined &&
    input.amountPaid > 0 &&
    usage.customerEmail &&
    usage.customerEmail.includes('@')
  ) {
    try {
      await usage.populate('items.product', 'name');
      await usage.populate('items.serializedItemId', 'assetId manufacturerSerial');
      const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
      const assetId =
        (usage.items[0]?.serializedItemId as any)?.assetId ||
        (usage.items[0]?.serializedItemId as any)?.manufacturerSerial;
      const nextPayment = usage.monthlyPayments.find((p) => p.status !== 'PAID');

      sendRentalPaymentReceiptEmail({
        recipientEmail: usage.customerEmail,
        customerName: usage.assignedPerson,
        customerContact: usage.assignedPersonContact,
        issueReference: usage.issueReference,
        productName: prodName,
        assetId,
        amountPaid: payment.amountPaid,
        amountDue: payment.amountDue,
        paymentMethod: payment.paymentMethod || 'UPI',
        transactionRef: payment.transactionRef,
        billingMonth: payment.billingMonth,
        paidAt: payment.paidAt || new Date(),
        totalRentPaid: usage.totalRentPaid,
        totalRentDue: usage.totalRentDue,
        nextDueDate: nextPayment?.dueDate,
        recordedBy: { name: actor.name, email: actor.email, role: actor.role },
        notes: payment.notes,
      }).catch((emailErr) => {
        console.error('[EMAIL_RECEIPT_ERROR] Failed to dispatch updated receipt email:', emailErr);
      });
    } catch (err) {
      console.error('[EMAIL_RECEIPT_PREP_ERROR]', err);
    }
  }

  return usage;
}

export async function adjustRentalMonthDue(
  usageId: string,
  input: {
    monthIndex: number;
    newAmountDue: number;
    reason?: string;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  const payment = usage.monthlyPayments.find((p) => p.monthIndex === input.monthIndex);
  if (!payment) {
    throw new AppError(`Month ${input.monthIndex} not found in rental schedule.`, 404, 'MONTH_NOT_FOUND');
  }

  const prevDue = payment.amountDue;
  payment.amountDue = Math.max(0, input.newAmountDue);
  if (input.reason) {
    payment.notes = (payment.notes ? payment.notes + ' | ' : '') + input.reason;
  }

  if (payment.amountPaid >= payment.amountDue && payment.amountDue > 0) {
    payment.status = 'PAID';
  } else {
    payment.status = 'DUE';
  }

  // Auto-carry forward any difference to the next month
  const diff = prevDue - payment.amountDue;
  if (diff !== 0) {
    const nextPayment = usage.monthlyPayments.find((p) => p.monthIndex === payment.monthIndex + 1);
    if (nextPayment) {
      nextPayment.amountDue = Math.max(0, nextPayment.amountDue + diff);
      const diffText = diff > 0 ? `+₹${diff}` : `-₹${Math.abs(diff)}`;
      nextPayment.notes = `${nextPayment.notes ? nextPayment.notes + ' | ' : ''}Auto-adjusted (${diffText}) from Month ${payment.monthIndex} edit`;
    } else if (diff > 0) {
      // Append next month automatically so the remaining balance is carried forward
      const lastPayment = usage.monthlyPayments[usage.monthlyPayments.length - 1];
      const nextDueDate = new Date(lastPayment.dueDate);
      nextDueDate.setMonth(nextDueDate.getMonth() + 1);
      const nextMonthName = nextDueDate.toLocaleString('default', { month: 'short', year: 'numeric' });
      const nextIndex = payment.monthIndex + 1;
      usage.monthlyPayments.push({
        monthIndex: nextIndex,
        billingMonth: `Month ${nextIndex} (${nextMonthName})`,
        dueDate: nextDueDate,
        amountDue: diff,
        amountPaid: 0,
        status: 'DUE',
        notes: `Auto-generated to carry forward ₹${diff} from Month ${payment.monthIndex} adjustment`,
      });
      usage.lockInPeriodMonths = Math.max(usage.lockInPeriodMonths || 0, nextIndex);
      if (!usage.expectedReturnDate || nextDueDate > new Date(usage.expectedReturnDate)) {
        usage.expectedReturnDate = nextDueDate;
      }
    }
  }

  // Recalculate totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  usage.markModified('monthlyPayments');
  await usage.save();

  await usage.populate('location', 'name code');
  await usage.populate('issuedBy', 'name email');
  await usage.populate('items.product', 'name sku brand trackingMode color defaultSellingPrice purchaseCost');
  await usage.populate('items.serializedItemId', 'assetId manufacturerSerial condition status');

  await logAudit({
    actor,
    action: 'RENTAL_MONTH_DUE_ADJUSTED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { monthIndex: input.monthIndex, prevDue, newDue: payment.amountDue },
    reason: `Adjusted rent for Month ${input.monthIndex} from ₹${prevDue} to ₹${payment.amountDue}. ${input.reason || ''}`,
  });

  return usage;
}

export async function addRentalMonth(
  usageId: string,
  input: {
    amountDue?: number;
    dueDate?: string;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  const nextIndex =
    (usage.monthlyPayments.length > 0
      ? Math.max(...usage.monthlyPayments.map((p) => p.monthIndex))
      : 0) + 1;

  let newDueDate: Date;
  if (input.dueDate) {
    newDueDate = new Date(input.dueDate);
  } else if (usage.monthlyPayments.length > 0) {
    const lastPayment = usage.monthlyPayments[usage.monthlyPayments.length - 1];
    newDueDate = new Date(lastPayment.dueDate);
    newDueDate.setMonth(newDueDate.getMonth() + 1);
  } else {
    newDueDate = new Date();
  }

  const monthName = newDueDate.toLocaleString('default', { month: 'short', year: 'numeric' });
  const agreedRent =
    input.amountDue !== undefined ? Math.max(0, input.amountDue) : usage.monthlyRent;

  usage.monthlyPayments.push({
    monthIndex: nextIndex,
    billingMonth: `Month ${nextIndex} (${monthName})`,
    dueDate: newDueDate,
    amountDue: agreedRent,
    amountPaid: 0,
    status: 'DUE',
  });

  // Keep lockInPeriodMonths and expectedReturnDate in sync with added months
  usage.lockInPeriodMonths = Math.max(usage.lockInPeriodMonths || 0, nextIndex);
  if (!usage.expectedReturnDate || newDueDate > new Date(usage.expectedReturnDate)) {
    usage.expectedReturnDate = newDueDate;
  }

  // Re-calculate totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  usage.markModified('monthlyPayments');
  await usage.save();

  await usage.populate('location', 'name code');
  await usage.populate('issuedBy', 'name email');
  await usage.populate('items.product', 'name sku brand trackingMode color defaultSellingPrice purchaseCost');
  await usage.populate('items.serializedItemId', 'assetId manufacturerSerial condition status');

  await logAudit({
    actor,
    action: 'RENTAL_MONTH_ADDED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { nextIndex, agreedRent, dueDate: newDueDate, lockInPeriodMonths: usage.lockInPeriodMonths },
    reason: `Added Month ${nextIndex} to rental schedule for ${usage.assignedPerson}`,
  });

  return usage;
}

export async function sendRentalReminder(
  usageId: string,
  actor: AuthenticatedUser,
  options?: {
    recipientEmail?: string;
    customNote?: string;
  }
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('items.product', 'name sku brand')
    .populate('items.serializedItemId', 'assetId manufacturerSerial');

  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  const recipient = (options?.recipientEmail || usage.customerEmail || '').trim();
  const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
  const assetId =
    (usage.items[0]?.serializedItemId as any)?.assetId ||
    (usage.items[0]?.serializedItemId as any)?.manufacturerSerial;

  const now = new Date();
  const unpaidMonths = usage.monthlyPayments?.filter((p) => p.status !== 'PAID') || [];
  const overdueMonths = unpaidMonths.filter((p) => new Date(p.dueDate) < now);
  const oldestDue = overdueMonths[0] || unpaidMonths[0];

  const pendingAmount =
    usage.totalRentDue > 0
      ? usage.totalRentDue
      : oldestDue
      ? Math.max(0, oldestDue.amountDue - (oldestDue.amountPaid || 0))
      : usage.monthlyRent || 0;

  const daysOverdue =
    oldestDue && new Date(oldestDue.dueDate) < now
      ? Math.max(
          1,
          Math.floor((now.getTime() - new Date(oldestDue.dueDate).getTime()) / (1000 * 60 * 60 * 24))
        )
      : usage.expectedReturnDate && new Date(usage.expectedReturnDate) < now
      ? Math.max(
          1,
          Math.floor(
            (now.getTime() - new Date(usage.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
          )
        )
      : 0;

  const reminderMessage = `Dear ${usage.assignedPerson}, this is a payment reminder from Stereobliss Retail & Rentals. Your rental payment of ₹${pendingAmount} for "${prodName}" (Ref: ${usage.issueReference}) is due. Please pay via UPI/Card at your earliest convenience. Thank you!`;

  let emailDeliveryResult: any = null;
  let emailDispatched = false;

  if (recipient && recipient.includes('@')) {
    try {
      emailDeliveryResult = await sendRentalPaymentReminderEmail({
        recipientEmail: recipient,
        customerName: usage.assignedPerson,
        customerContact: usage.assignedPersonContact,
        issueReference: usage.issueReference,
        productName: prodName,
        assetId,
        pendingAmount,
        monthlyRent: usage.monthlyRent || 0,
        dueDate: oldestDue?.dueDate || usage.expectedReturnDate,
        billingMonth: oldestDue?.billingMonth,
        daysOverdue,
        customNote: options?.customNote,
        sentBy: { name: actor.name, email: actor.email, role: actor.role },
      });
      emailDispatched = true;
    } catch (err: any) {
      console.error('[EMAIL_REMINDER_ERROR] Failed to send reminder email:', err);
    }
  }

  const destination = recipient || usage.assignedPersonContact || usage.assignedPerson;
  usage.remindersSent.push({
    sentAt: new Date(),
    sentTo: destination,
    channel: recipient ? 'EMAIL' : 'SMS',
    message: reminderMessage,
    sentBy: new Types.ObjectId(actor.id),
  });

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_REMINDER_SENT',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { recipient: destination, pendingAmount, emailDispatched },
    reason: `Dispatched payment reminder to ${destination}${emailDispatched ? ' via Email' : ''}`,
  });

  return {
    success: true,
    message: reminderMessage,
    sentTo: destination,
    channel: recipient ? 'EMAIL' : 'SMS',
    emailDispatched,
    emailStatus: emailDeliveryResult?.status || (emailDispatched ? 'SENT' : 'NO_EMAIL_CONFIGURED'),
    sentAt: new Date(),
    usage,
  };
}

export async function getRentalDuesSummary() {
  const now = new Date();
  // Upcoming horizon: only notify for payments due within the next 7 days
  const reminderHorizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const usages = await InternalUsage.find({
    status: {
      $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED, USAGE_STATUSES.OVERDUE],
    },
  })
    .populate('items.product', 'name sku brand')
    .populate('items.serializedItemId', 'assetId manufacturerSerial condition')
    .sort({ expectedReturnDate: 1 })
    .lean();

  let totalPendingAmount = 0;
  let totalOverdueAmount = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;

  const items: any[] = [];

  for (const u of usages) {
    // Skip if completely returned or closed
    if (u.status === USAGE_STATUSES.RETURNED) {
      continue;
    }
    const allReturned =
      (u.items || []).length > 0 &&
      u.items.every((i) => (i.quantityReturned || 0) >= (i.quantityIssued || 0));
    if (allReturned) {
      continue;
    }

    const unpaidMonths = (u.monthlyPayments || []).filter((p) => p.status !== 'PAID');
    const actualUnpaidRent = unpaidMonths.reduce(
      (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
      0
    );

    // Deposit-mode rentals:
    // If deposit is active and has balance > 0, rent is covered by deposit deductions.
    // Only if depositExhausted is true (or depositBalance <= 0) does the customer owe direct continuation rent.
    if ((u as any).depositMode && !(u as any).depositExhausted && ((u as any).depositBalance ?? 0) > 0) {
      // Dues are deducted from deposit — not customer direct dues.
      // If there's an overdue physical return, we check that below; otherwise skip.
      if (!u.expectedReturnDate || new Date(u.expectedReturnDate) >= now) {
        continue;
      }
    }

    const isReturnOverdue = Boolean(u.expectedReturnDate && new Date(u.expectedReturnDate) < now && !allReturned);

    // If all rent has been paid:
    if (actualUnpaidRent <= 0) {
      if (isReturnOverdue) {
        // Physical instrument return is overdue, but ZERO money is owed
        const primaryItem = u.items && u.items.length > 0 ? u.items[0] : null;
        const prod = primaryItem?.product as any;
        const serialUnit = primaryItem?.serializedItemId as any;
        const daysOverdue = Math.max(
          1,
          Math.floor((now.getTime() - new Date(u.expectedReturnDate!).getTime()) / (1000 * 60 * 60 * 24))
        );

        overdueCount++;
        items.push({
          id: u._id.toString(),
          issueReference: u.issueReference,
          loanType: 'RENTAL',
          assignedPerson: u.assignedPerson,
          customerEmail: u.customerEmail,
          assignedPersonContact: u.assignedPersonContact,
          productName: prod?.name || 'Musical Instrument',
          assetId: serialUnit?.assetId || serialUnit?.manufacturerSerial,
          totalRentDue: 0,
          monthlyRent: u.monthlyRent || 0,
          nextDueDate: u.expectedReturnDate,
          daysOverdue,
          status: 'OVERDUE',
          billingMonth: 'Equipment Return Overdue',
          remindersSentCount: u.remindersSent?.length || 0,
          lastReminderSentAt: u.remindersSent?.[u.remindersSent.length - 1]?.sentAt,
        });
      }
      // If rent is paid and return is not overdue, skip completely!
      continue;
    }

    // There is unpaid rent! Check the earliest unpaid month:
    const oldestDue = unpaidMonths[0];
    const targetDueDate = oldestDue ? new Date(oldestDue.dueDate) : (u.expectedReturnDate ? new Date(u.expectedReturnDate) : now);
    const isPaymentOverdue = targetDueDate < now;
    const isDueSoon = targetDueDate >= now && targetDueDate <= reminderHorizon;

    // If the payment is not overdue AND not due within the next 7 days,
    // that means the customer paid their current month before the deadline,
    // and the next installment is weeks away. Do NOT trigger a notification!
    if (!isPaymentOverdue && !isDueSoon && !isReturnOverdue) {
      continue;
    }

    const isOverdue = isPaymentOverdue || isReturnOverdue;
    let daysOverdue = 0;
    if (isOverdue) {
      daysOverdue = Math.max(
        1,
        Math.floor((now.getTime() - targetDueDate.getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    // Precise amount due for this current/oldest unpaid month
    const currentMonthDue = oldestDue
      ? Math.max(0, oldestDue.amountDue - (oldestDue.amountPaid || 0))
      : actualUnpaidRent;

    totalPendingAmount += currentMonthDue;
    if (isOverdue) {
      totalOverdueAmount += currentMonthDue;
      overdueCount++;
    } else {
      dueSoonCount++;
    }

    const primaryItem = u.items && u.items.length > 0 ? u.items[0] : null;
    const prod = primaryItem?.product as any;
    const serialUnit = primaryItem?.serializedItemId as any;

    items.push({
      id: u._id.toString(),
      issueReference: u.issueReference,
      loanType: 'RENTAL',
      assignedPerson: u.assignedPerson,
      customerEmail: u.customerEmail,
      assignedPersonContact: u.assignedPersonContact,
      productName: prod?.name || 'Musical Instrument',
      assetId: serialUnit?.assetId || serialUnit?.manufacturerSerial,
      totalRentDue: currentMonthDue,
      monthlyRent: u.monthlyRent || 0,
      nextDueDate: targetDueDate,
      daysOverdue,
      status: isOverdue ? 'OVERDUE' : 'UPCOMING',
      billingMonth: oldestDue?.billingMonth || 'Active Loan Cycle',
      remindersSentCount: u.remindersSent?.length || 0,
      lastReminderSentAt: u.remindersSent?.[u.remindersSent.length - 1]?.sentAt,
    });
  }

  // Also query active EMI Sales with pending installment dues
  const emiSales = await Sale.find({
    isEmi: true,
    totalEmiDue: { $gt: 0 },
    paymentStatus: { $ne: 'PAID' },
    saleStatus: { $nin: ['CANCELLED', 'RETURNED'] },
  })
    .populate('lineItems.product', 'name sku brand')
    .sort({ createdAt: 1 })
    .lean();

  for (const sale of emiSales) {
    const unpaidEmis = (sale.emiPayments || []).filter((p) => p.status !== 'PAID');
    const actualUnpaidEmi = unpaidEmis.reduce(
      (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
      0
    );

    // If actual unpaid is 0, skip!
    if (actualUnpaidEmi <= 0) continue;

    const oldestDue = unpaidEmis[0];
    const targetDueDate = oldestDue?.dueDate ? new Date(oldestDue.dueDate) : new Date(sale.createdAt);

    const isEmiOverdue = targetDueDate < now;
    const isEmiDueSoon = targetDueDate >= now && targetDueDate <= reminderHorizon;

    // If not overdue and not due within 7 days, customer paid their recent EMI before deadline!
    if (!isEmiOverdue && !isEmiDueSoon) {
      continue;
    }

    let daysOverdue = 0;
    if (isEmiOverdue) {
      daysOverdue = Math.max(
        1,
        Math.floor((now.getTime() - targetDueDate.getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    const currentInstallmentDue = oldestDue
      ? Math.max(0, oldestDue.amountDue - (oldestDue.amountPaid || 0))
      : actualUnpaidEmi;

    totalPendingAmount += currentInstallmentDue;
    if (isEmiOverdue) {
      totalOverdueAmount += currentInstallmentDue;
      overdueCount++;
    } else {
      dueSoonCount++;
    }

    const prodNames =
      sale.lineItems?.map((li: any) => li.product?.name).filter(Boolean).join(', ') || 'Musical Equipment';

    items.push({
      id: sale._id.toString(),
      issueReference: sale.invoiceNumber,
      loanType: 'EMI',
      assignedPerson: sale.customerName,
      customerEmail: sale.customerEmail,
      assignedPersonContact: sale.customerPhone,
      productName: prodNames,
      totalRentDue: currentInstallmentDue,
      monthlyRent: sale.monthlyEmiAmount || currentInstallmentDue,
      nextDueDate: targetDueDate,
      daysOverdue,
      status: isEmiOverdue ? 'OVERDUE' : 'UPCOMING',
      billingMonth: oldestDue?.billingMonth || 'Active EMI Plan',
      remindersSentCount: sale.remindersSent?.length || 0,
      lastReminderSentAt: sale.remindersSent?.[sale.remindersSent.length - 1]?.sentAt,
    });
  }

  // Sort items: OVERDUE first (descending daysOverdue), then UPCOMING (closest nextDueDate first)
  items.sort((a, b) => {
    if (a.status === 'OVERDUE' && b.status !== 'OVERDUE') return -1;
    if (a.status !== 'OVERDUE' && b.status === 'OVERDUE') return 1;
    if (a.status === 'OVERDUE' && b.status === 'OVERDUE') {
      return b.daysOverdue - a.daysOverdue;
    }
    return new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime();
  });

  return {
    summary: {
      totalPendingAmount,
      totalOverdueAmount,
      overdueCount,
      dueSoonCount,
      totalRentalsWithDues: items.length,
    },
    items,
  };
}

export async function sendBulkRentalReminders(
  usageIds: string[] | undefined,
  actor: AuthenticatedUser
) {
  let targetIds = usageIds;
  if (!targetIds || targetIds.length === 0) {
    const summary = await getRentalDuesSummary();
    targetIds = summary.items.filter((item) => item.customerEmail).map((item) => item.id);
  }

  let sentCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  for (const id of targetIds) {
    try {
      const usage = await InternalUsage.findById(id);
      if (usage) {
        const res = await sendRentalReminder(id, actor);
        if (res.emailDispatched) {
          sentCount++;
        } else {
          skippedCount++;
        }
      } else {
        const sale = await Sale.findById(id);
        if (sale && sale.isEmi) {
          const { sendEmiReminder } = await import('./salesService.js');
          const res = await sendEmiReminder(id, actor);
          if (res.emailDispatched) {
            sentCount++;
          } else {
            skippedCount++;
          }
        } else {
          skippedCount++;
        }
      }
    } catch (err: any) {
      errors.push(`Record ${id}: ${err.message}`);
    }
  }

  return {
    totalRequested: targetIds.length,
    sentCount,
    skippedCount,
    errors,
  };
}

/**
 * Records a monthly rent deduction from the customer's security deposit.
 * Called by manager/admin each month — marks the month as PAID via deposit,
 * reduces depositBalance, and queues a "notice pending" flag for the bell.
 */
export async function recordDepositDeduction(
  usageId: string,
  input: {
    monthIndex: number;
    billingMonth: string;
    amount?: number;
    allowPartial?: boolean;
    notes?: string;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('items.product', 'name sku brand')
    .populate('items.serializedItemId', 'assetId manufacturerSerial');

  if (!usage) throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  if (!(usage as any).depositMode) {
    throw new AppError('This rental is not in deposit-deduction mode.', 400, 'NOT_DEPOSIT_MODE');
  }

  const balanceBefore = typeof (usage as any).depositBalance === 'number' ? (usage as any).depositBalance : 0;
  if ((usage as any).depositExhausted || balanceBefore <= 0) {
    (usage as any).depositExhausted = true;
    if (!(usage as any).continuationStartedAt) {
      (usage as any).continuationStartedAt = new Date();
    }
    await usage.save();
    throw new AppError(
      'Security deposit is fully exhausted (₹0 balance). Customer must now pay rent directly via continuation mode.',
      400,
      'DEPOSIT_EXHAUSTED'
    );
  }

  const payment = usage.monthlyPayments.find((p) => p.monthIndex === input.monthIndex);
  if (!payment) {
    throw new AppError(`Month ${input.monthIndex} not found in rental schedule.`, 404, 'MONTH_NOT_FOUND');
  }
  if (payment.status === 'PAID') {
    throw new AppError(`Month ${input.monthIndex} (${payment.billingMonth}) is already marked as PAID.`, 400, 'ALREADY_PAID');
  }

  const unpaidOnMonth = Math.max(0, payment.amountDue - (payment.amountPaid || 0));

  // Determine deductAmount: allow user-specified amount, or auto-partial deduction if balance < unpaidOnMonth
  let deductAmount: number;
  if (typeof input.amount === 'number' && input.amount > 0) {
    deductAmount = Math.min(input.amount, balanceBefore, unpaidOnMonth);
  } else if (input.allowPartial || balanceBefore < unpaidOnMonth) {
    deductAmount = Math.min(balanceBefore, unpaidOnMonth);
  } else {
    deductAmount = unpaidOnMonth;
  }

  if (deductAmount <= 0) {
    throw new AppError(
      `No remaining balance to deduct. Available deposit: ₹${balanceBefore}, Month unpaid due: ₹${unpaidOnMonth}.`,
      400,
      'INVALID_DEDUCT_AMOUNT'
    );
  }

  const balanceAfter = Math.max(0, balanceBefore - deductAmount);
  const nowExhausted = balanceAfter <= 0;

  // Mark/update this month payment
  payment.amountPaid = (payment.amountPaid || 0) + deductAmount;
  payment.paidAt = new Date();
  payment.paymentMethod = 'DEPOSIT';
  payment.transactionRef = `DEP-DEDUCT-M${input.monthIndex}-${usage.issueReference}`;

  if (payment.amountPaid >= payment.amountDue) {
    payment.status = 'PAID';
    payment.notes = (payment.notes ? payment.notes + ' | ' : '') + `Rent deducted from security deposit by ${actor.name}`;
  } else {
    payment.status = 'DUE';
    payment.notes = (payment.notes ? payment.notes + ' | ' : '') + `Partial rent ₹${deductAmount} deducted from deposit. Remaining ₹${payment.amountDue - payment.amountPaid} carried to direct continuation payment.`;
  }

  // Update deposit balance
  (usage as any).depositBalance = balanceAfter;
  (usage as any).depositExhausted = nowExhausted;
  if (nowExhausted && !(usage as any).continuationStartedAt) {
    (usage as any).continuationStartedAt = new Date();
  }

  // Push a deposit deduction record — noticeSent starts false (bell will prompt manager to send email)
  (usage as any).depositDeductions.push({
    monthIndex: input.monthIndex,
    billingMonth: payment.billingMonth,
    deductedAmount: deductAmount,
    depositBalanceBefore: balanceBefore,
    depositBalanceAfter: balanceAfter,
    deductedAt: new Date(),
    deductedBy: new Types.ObjectId(actor.id),
    noticeSent: false,
    notes: input.notes?.trim() || (nowExhausted && balanceAfter === 0 ? 'Remaining deposit exhausted — switched to continuation mode' : undefined),
  });

  // If deposit is now exhausted, auto-generate continuation monthly payment rows
  // so the manager can track ongoing rent payments from the customer directly.
  if (nowExhausted) {
    const lastMonthIndex = Math.max(...usage.monthlyPayments.map((p) => p.monthIndex), 0);
    const existingIndices = new Set(usage.monthlyPayments.map((p) => p.monthIndex));
    const totalExpected = usage.lockInPeriodMonths || 0;

    // Generate any remaining months that haven't been created yet as DUE continuation months
    const lastDueDate =
      usage.monthlyPayments.length > 0
        ? new Date(usage.monthlyPayments[usage.monthlyPayments.length - 1].dueDate)
        : new Date();

    for (let m = lastMonthIndex + 1; m <= totalExpected; m++) {
      if (!existingIndices.has(m)) {
        const dueDate = new Date(lastDueDate);
        dueDate.setMonth(dueDate.getMonth() + (m - lastMonthIndex));
        const monthName = dueDate.toLocaleString('default', { month: 'short', year: 'numeric' });
        usage.monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m} (${monthName}) — Continuation`,
          dueDate,
          amountDue: usage.monthlyRent || deductAmount,
          amountPaid: 0,
          status: 'DUE',
          notes: 'Deposit exhausted — customer pays directly from this month',
        } as any);
      }
    }
  }

  // Recalculate rent totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  // Append to payment log
  (usage as any).paymentLogs.push({
    paymentType: 'DEPOSIT_DEDUCTION',
    amount: deductAmount,
    paymentMethod: 'DEPOSIT',
    transactionRef: `DEP-DEDUCT-M${input.monthIndex}-${usage.issueReference}`,
    billingMonth: payment.billingMonth,
    notes: `Security deposit deducted for ${payment.billingMonth}. Balance: ₹${balanceBefore} → ₹${balanceAfter}`,
    recordedBy: new Types.ObjectId(actor.id),
    paidAt: new Date(),
  });

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_DEPOSIT_DEDUCTED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: {
      monthIndex: input.monthIndex,
      billingMonth: payment.billingMonth,
      deductedAmount: deductAmount,
      depositBalanceBefore: balanceBefore,
      depositBalanceAfter: balanceAfter,
      depositExhausted: nowExhausted,
    },
    reason: `Monthly rent ₹${deductAmount} deducted from deposit for ${payment.billingMonth}. Remaining balance: ₹${balanceAfter}`,
  });

  // Automatically dispatch Rent Auto-Deduction notice email to customer
  if (usage.customerEmail && usage.customerEmail.includes('@')) {
    const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
    const assetId =
      (usage.items[0]?.serializedItemId as any)?.assetId ||
      (usage.items[0]?.serializedItemId as any)?.manufacturerSerial;

    setImmediate(async () => {
      try {
        await sendDepositDeductionNoticeEmail({
          recipientEmail: usage.customerEmail!,
          customerName: usage.assignedPerson,
          customerContact: usage.assignedPersonContact,
          issueReference: usage.issueReference,
          productName: prodName,
          assetId,
          billingMonth: payment.billingMonth,
          deductedAmount: deductAmount,
          depositBalanceBefore: balanceBefore,
          depositBalanceAfter: balanceAfter,
          depositExhausted: nowExhausted,
          deductedAt: new Date(),
          sentBy: { name: actor.name, email: actor.email, role: actor.role },
          notes: input.notes,
        });

        // Mark deduction noticeSent as true in database
        await InternalUsage.updateOne(
          { _id: usage._id, 'depositDeductions.billingMonth': payment.billingMonth },
          {
            $set: {
              'depositDeductions.$.noticeSent': true,
              'depositDeductions.$.noticeSentAt': new Date(),
              'depositDeductions.$.noticeSentBy': new Types.ObjectId(actor.id),
            },
          }
        );
      } catch (emailErr) {
        console.error('[EMAIL_DEDUCTION_NOTICE_ERROR] Failed to send deduction notice email:', emailErr);
      }
    });
  }

  // If deposit just got exhausted, send automatic exhaustion notice email (fire-and-forget)
  if (nowExhausted && usage.customerEmail && usage.customerEmail.includes('@')) {
    const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
    setImmediate(async () => {
      try {
        await sendDepositExhaustionEmail({
          recipientEmail: usage.customerEmail!,
          customerName: usage.assignedPerson,
          customerContact: usage.assignedPersonContact,
          issueReference: usage.issueReference,
          productName: prodName,
          monthlyRent: usage.monthlyRent || deductAmount,
          lastBillingMonth: payment.billingMonth,
          sentBy: { name: actor.name, email: actor.email, role: actor.role },
        });
      } catch (emailErr) {
        console.error('[EMAIL_EXHAUSTION_ERROR] Failed to send deposit exhaustion email:', emailErr);
      }
    });
  }

  return usage;
}

/**
 * Explicitly activates continuation mode on a rental agreement.
 * Useful when remaining deposit is insufficient for full rent, or when customer/manager
 * chooses to start direct monthly rent collection.
 */
export async function activateContinuationMode(
  usageId: string,
  input: { notes?: string },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('items.product', 'name sku brand defaultSellingPrice purchaseCost')
    .populate('items.serializedItemId', 'assetId manufacturerSerial');

  if (!usage) throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');

  (usage as any).depositExhausted = true;
  if (!(usage as any).continuationStartedAt) {
    (usage as any).continuationStartedAt = new Date();
  }

  // Auto-generate continuation months up to lockInPeriodMonths
  const lastMonthIndex = Math.max(...(usage.monthlyPayments || []).map((p) => p.monthIndex), 0);
  const existingIndices = new Set((usage.monthlyPayments || []).map((p) => p.monthIndex));
  const totalExpected = usage.lockInPeriodMonths || 3;

  const lastDueDate =
    usage.monthlyPayments && usage.monthlyPayments.length > 0
      ? new Date(usage.monthlyPayments[usage.monthlyPayments.length - 1].dueDate)
      : new Date();

  for (let m = lastMonthIndex + 1; m <= totalExpected; m++) {
    if (!existingIndices.has(m)) {
      const dueDate = new Date(lastDueDate);
      dueDate.setMonth(dueDate.getMonth() + (m - lastMonthIndex));
      const monthName = dueDate.toLocaleString('default', { month: 'short', year: 'numeric' });
      usage.monthlyPayments.push({
        monthIndex: m,
        billingMonth: `Month ${m} (${monthName}) — Continuation`,
        dueDate,
        amountDue: usage.monthlyRent || 0,
        amountPaid: 0,
        status: 'DUE',
        notes: 'Continuation mode active — customer pays rent directly',
      } as any);
    }
  }

  // Recalculate rent totals
  usage.totalRentPaid = (usage.monthlyPayments || []).reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = (usage.monthlyPayments || []).reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_CONTINUATION_ACTIVATED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: {
      depositExhausted: true,
      depositBalance: (usage as any).depositBalance,
      notes: input?.notes,
    },
    reason: input?.notes || 'Continuation mode explicitly activated by manager',
  });

  return usage;
}

/**
 * Marks a deposit deduction's notice as sent and dispatches the email to the customer.
 * Called when manager/admin clicks "Send Notice Email" from the notification bell.
 */
export async function sendDepositDeductionNotice(
  usageId: string,
  deductionId: string,
  actor: AuthenticatedUser,
  options?: { customNote?: string; recipientEmail?: string }
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('items.product', 'name sku brand')
    .populate('items.serializedItemId', 'assetId manufacturerSerial');

  if (!usage) throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');

  const deductions = (usage as any).depositDeductions as any[];
  const deduction = deductions.find((d: any) => d._id?.toString() === deductionId);
  if (!deduction) throw new AppError('Deposit deduction record not found.', 404, 'DEDUCTION_NOT_FOUND');

  const recipient = options?.recipientEmail || usage.customerEmail || '';
  if (!recipient || !recipient.includes('@')) {
    throw new AppError(
      'No valid customer email address on file. Please add the customer email to send a notice.',
      400,
      'NO_EMAIL'
    );
  }

  const prodName = (usage.items[0]?.product as any)?.name || 'Musical Instrument';
  const assetId =
    (usage.items[0]?.serializedItemId as any)?.assetId ||
    (usage.items[0]?.serializedItemId as any)?.manufacturerSerial;

  await sendDepositDeductionNoticeEmail({
    recipientEmail: recipient,
    customerName: usage.assignedPerson,
    customerContact: usage.assignedPersonContact,
    issueReference: usage.issueReference,
    productName: prodName,
    assetId,
    billingMonth: deduction.billingMonth,
    deductedAmount: deduction.deductedAmount,
    depositBalanceBefore: deduction.depositBalanceBefore,
    depositBalanceAfter: deduction.depositBalanceAfter,
    depositExhausted: (usage as any).depositExhausted ?? false,
    deductedAt: deduction.deductedAt,
    sentBy: { name: actor.name, email: actor.email, role: actor.role },
    notes: options?.customNote,
  });

  // Mark notice as sent
  deduction.noticeSent = true;
  deduction.noticeSentAt = new Date();
  deduction.noticeSentBy = new Types.ObjectId(actor.id);

  // Also add to remindersSent for full audit trail
  usage.remindersSent.push({
    sentAt: new Date(),
    sentTo: recipient,
    channel: 'EMAIL',
    message: `Deposit deduction notice sent for ${deduction.billingMonth} (₹${deduction.deductedAmount}). Remaining balance: ₹${deduction.depositBalanceAfter}`,
    sentBy: new Types.ObjectId(actor.id),
  });

  await usage.save();

  await logAudit({
    actor,
    action: 'DEPOSIT_DEDUCTION_NOTICE_SENT',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { deductionId, billingMonth: deduction.billingMonth, sentTo: recipient },
    reason: `Deposit deduction notice email sent to ${recipient} for ${deduction.billingMonth}`,
  });

  return {
    success: true,
    sentTo: recipient,
    billingMonth: deduction.billingMonth,
    deductedAmount: deduction.deductedAmount,
    depositBalanceAfter: deduction.depositBalanceAfter,
    usage,
  };
}

export async function updateRentalAgreement(
  usageId: string,
  input: {
    assignedPerson?: string;
    assignedPersonContact?: string;
    customerEmail?: string;
    lockInPeriodMonths?: number;
    monthlyRent?: number;
    securityDeposit?: number;
    depositMode?: boolean;
    notes?: string;
    payAllRemainingNow?: boolean;
    paymentMethod?: string;
    transactionRef?: string;
  },
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId)
    .populate('location', 'name code')
    .populate('items.product', 'name sku brand trackingMode color defaultSellingPrice purchaseCost')
    .populate('items.serializedItemId', 'assetId manufacturerSerial condition status');

  if (!usage) {
    throw new AppError('Rental record not found.', 404, 'RENTAL_NOT_FOUND');
  }

  if (input.assignedPerson) usage.assignedPerson = input.assignedPerson.trim();
  if (input.assignedPersonContact !== undefined) usage.assignedPersonContact = input.assignedPersonContact.trim();
  if (input.customerEmail !== undefined) usage.customerEmail = input.customerEmail.trim().toLowerCase() || undefined;
  if (input.notes !== undefined) usage.notes = input.notes.trim();

  if (input.monthlyRent !== undefined && input.monthlyRent >= 0) {
    usage.monthlyRent = Math.round(input.monthlyRent);
  }
  if (input.securityDeposit !== undefined && input.securityDeposit >= 0) {
    usage.securityDeposit = Math.round(input.securityDeposit);
  }
  if (input.depositMode !== undefined) {
    usage.depositMode = input.depositMode;
  }

  const baseDate = usage.issueDate ? new Date(usage.issueDate) : new Date();

  // If tenure is updated, preserve existing scheduled months (including manually added ones)
  if (input.lockInPeriodMonths !== undefined && input.lockInPeriodMonths > 0) {
    const targetTenure = Math.max(1, input.lockInPeriodMonths);
    usage.lockInPeriodMonths = targetTenure;

    const currentPayments = usage.monthlyPayments || [];
    const paidMonths = currentPayments.filter((p) => p.status === 'PAID');
    const currentTotal = currentPayments.length;

    if (targetTenure > currentTotal) {
      // Append extra months up to targetTenure
      for (let m = currentTotal + 1; m <= targetTenure; m++) {
        const dueDate = addMonthsPreservingDay(baseDate, m);
        const monthName = dueDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
        usage.monthlyPayments.push({
          monthIndex: m,
          billingMonth: `Month ${m} (${monthName})`,
          dueDate,
          amountDue: usage.monthlyRent || 0,
          amountPaid: 0,
          status: 'DUE',
        });
      }
    } else if (targetTenure < currentTotal) {
      // If reducing tenure, only remove trailing unpaid months down to targetTenure or paidCount
      const keepCount = Math.max(paidMonths.length, targetTenure);
      usage.monthlyPayments = currentPayments.slice(0, keepCount);
    }

    // If monthly rent was updated, update unpaid scheduled months that have zero payments
    if (input.monthlyRent !== undefined && input.monthlyRent >= 0) {
      for (const p of usage.monthlyPayments) {
        if (p.status !== 'PAID' && (p.amountPaid || 0) === 0) {
          p.amountDue = usage.monthlyRent;
        }
      }
    }

    usage.expectedReturnDate = addMonthsPreservingDay(baseDate, Math.max(targetTenure, usage.monthlyPayments.length));
  }

  // If user selected "Pay All Remaining Now"
  if (input.payAllRemainingNow) {
    const txnRef = (input.transactionRef || '').trim() || `SETTLE-${usage.issueReference}`;
    const pMethod = input.paymentMethod || 'UPI';
    const now = new Date();

    for (const p of usage.monthlyPayments) {
      if (p.status !== 'PAID') {
        const remainingDue = Math.max(0, p.amountDue - (p.amountPaid || 0));
        p.amountPaid = p.amountDue;
        p.status = 'PAID';
        p.paidAt = now;
        p.paymentMethod = pMethod;
        p.transactionRef = txnRef;
        p.notes = (p.notes ? p.notes + ' | ' : '') + 'Paid in full via agreement settlement';

        if (!usage.paymentLogs) usage.paymentLogs = [];
        usage.paymentLogs.push({
          paymentType: 'RENTAL_PAYMENT',
          amount: remainingDue,
          paymentMethod: pMethod,
          transactionRef: txnRef,
          billingMonth: p.billingMonth,
          notes: 'Full rental buyout/settlement',
          recordedBy: new Types.ObjectId(actor.id),
          recordedAt: now,
        } as any);
      }
    }
  }

  // Recalculate totals
  usage.totalRentPaid = (usage.monthlyPayments || []).reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = (usage.monthlyPayments || []).reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  usage.markModified('monthlyPayments');
  usage.markModified('paymentLogs');

  await usage.save();

  await logAudit({
    actor,
    action: 'UPDATE_RENTAL_AGREEMENT',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: {
      issueReference: usage.issueReference,
      lockInPeriodMonths: usage.lockInPeriodMonths,
      monthlyRent: usage.monthlyRent,
      totalRentDue: usage.totalRentDue,
      totalRentPaid: usage.totalRentPaid,
    },
    reason: `Updated rental agreement terms / settlement for ${usage.issueReference}`,
  });

  return usage;
}

export interface RefundDepositInput {
  refundAmount: number;
  deductionAmount?: number;
  deductionReason?: string;
  paymentMethod?: string;
  transactionRef?: string;
  notes?: string;
  customerEmail?: string;
  sendReceiptEmail?: boolean;
}

export async function refundSecurityDeposit(
  usageId: string,
  input: RefundDepositInput,
  actor: AuthenticatedUser
) {
  const usage = await InternalUsage.findById(usageId);
  if (!usage) {
    throw new AppError('Rental agreement not found.', 404, 'NOT_FOUND');
  }

  const currentBalance = typeof usage.depositBalance === 'number' ? usage.depositBalance : 0;
  if (currentBalance <= 0) {
    throw new AppError('No refundable security deposit balance remaining on this agreement.', 400, 'NO_DEPOSIT_BALANCE');
  }

  const deductionAmount = Math.max(0, input.deductionAmount || 0);
  const refundAmount = Math.max(0, input.refundAmount || 0);
  const totalSettled = refundAmount + deductionAmount;

  if (totalSettled > currentBalance) {
    throw new AppError(
      `Total refund (₹${refundAmount}) + deductions (₹${deductionAmount}) cannot exceed available deposit balance (₹${currentBalance}).`,
      400,
      'EXCEEDS_DEPOSIT_BALANCE'
    );
  }

  const balanceBefore = currentBalance;
  const balanceAfter = Math.max(0, currentBalance - totalSettled);

  usage.depositBalance = balanceAfter;
  if (balanceAfter === 0) {
    usage.depositExhausted = true;
  }
  usage.depositRefundStatus = balanceAfter === 0 ? 'REFUNDED' : 'REFUND_PENDING';
  usage.depositRefundedAmount = (usage.depositRefundedAmount || 0) + refundAmount;
  usage.depositRefundedAt = new Date();
  usage.depositRefundMethod = input.paymentMethod || 'UPI';
  usage.depositRefundTxnRef = input.transactionRef || `REFUND-${Date.now()}`;
  usage.depositRefundNotes = input.notes || '';

  if (deductionAmount > 0) {
    usage.depositRefundDeductionAmount = (usage.depositRefundDeductionAmount || 0) + deductionAmount;
    usage.depositRefundDeductionReason = input.deductionReason || 'Damage or setup adjustment';

    if (!usage.depositDeductions) usage.depositDeductions = [];
    usage.depositDeductions.push({
      monthIndex: (usage.depositDeductions.length || 0) + 1,
      billingMonth: 'Return Damage / Adjustment Deduction',
      deductedAmount: deductionAmount,
      depositBalanceBefore: balanceBefore,
      depositBalanceAfter: balanceBefore - deductionAmount,
      deductedAt: new Date(),
      deductedBy: new Types.ObjectId(actor.id),
      noticeSent: true,
      notes: input.deductionReason || 'Deduction from deposit upon return inspection',
    });
  }

  usage.depositRefundProcessedBy = new Types.ObjectId(actor.id);

  if (!usage.paymentLogs) usage.paymentLogs = [];
  usage.paymentLogs.push({
    paymentType: 'DEPOSIT_REFUND',
    amount: refundAmount,
    paymentMethod: input.paymentMethod || 'UPI',
    transactionRef: input.transactionRef || `REFUND-${Date.now()}`,
    billingMonth: 'Security Deposit Refund',
    notes: input.notes || `Security deposit refund disbursed to customer${deductionAmount > 0 ? ` (Deduction: ₹${deductionAmount})` : ''}`,
    recordedBy: new Types.ObjectId(actor.id),
    paidAt: new Date(),
  });

  if (input.customerEmail && input.customerEmail.trim().includes('@')) {
    usage.customerEmail = input.customerEmail.trim().toLowerCase();
  }

  usage.markModified('depositDeductions');
  usage.markModified('paymentLogs');

  await usage.save();

  await logAudit({
    actor,
    action: 'UPDATE_INTERNAL_USAGE',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    beforeState: { depositBalance: balanceBefore },
    afterState: {
      depositBalance: balanceAfter,
      depositRefundedAmount: usage.depositRefundedAmount,
      refundAmount,
      deductionAmount,
    },
    reason: `Disbursed security deposit refund of ₹${refundAmount} (Deduction: ₹${deductionAmount}) for ${usage.issueReference}`,
  });

  const populated = await InternalUsage.findById(usage._id)
    .populate('location', 'name code')
    .populate('items.product', 'name sku brand trackingMode color defaultSellingPrice')
    .populate('items.serializedItemId', 'assetId manufacturerSerial condition status');

  // Automatically dispatch Security Deposit Refund Confirmation & Receipt to customer
  let emailSent = false;
  let deliveryLog: any = null;
  const targetEmail = (input.customerEmail || usage.customerEmail || '').trim().toLowerCase();

  if (input.sendReceiptEmail !== false && targetEmail && targetEmail.includes('@')) {
    try {
      const { sendDepositRefundReceiptEmail } = await import('./emailService.js');
      const prodName = (populated?.items[0]?.product as any)?.name || 'Musical Instrument';
      const assetId =
        (populated?.items[0]?.serializedItemId as any)?.assetId ||
        (populated?.items[0]?.serializedItemId as any)?.manufacturerSerial;

      deliveryLog = await sendDepositRefundReceiptEmail({
        recipientEmail: targetEmail,
        customerName: usage.assignedPerson,
        customerContact: usage.assignedPersonContact,
        issueReference: usage.issueReference,
        productName: prodName,
        assetId,
        initialDeposit: usage.securityDeposit || balanceBefore,
        refundAmount,
        deductionAmount,
        deductionReason: input.deductionReason,
        depositBalanceBefore: balanceBefore,
        depositBalanceAfter: balanceAfter,
        paymentMethod: input.paymentMethod || 'UPI',
        transactionRef: usage.depositRefundTxnRef || input.transactionRef || `REFUND-${Date.now()}`,
        processedAt: new Date(),
        processedBy: { name: actor.name, email: actor.email, role: actor.role },
        notes: input.notes,
      });
      emailSent = !!deliveryLog;
    } catch (emailErr) {
      console.error('[EMAIL_DEPOSIT_REFUND_ERROR] Failed to send deposit refund receipt email:', emailErr);
    }
  }

  return {
    usage: populated || usage,
    emailSent,
    recipient: targetEmail || undefined,
    provider: deliveryLog?.provider || (emailSent ? 'EMAIL' : undefined),
    message: emailSent
      ? `Deposit refund processed & receipt email dispatched to ${targetEmail}`
      : `Security deposit refund of ₹${refundAmount} processed successfully`,
  };
}
