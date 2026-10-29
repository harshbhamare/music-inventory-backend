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
          // In deposit mode, each month's rent will be deducted from deposit — not "due" from customer
          amountDue: depositMode ? monthlyRent : monthlyRent,
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
      issueDate: new Date(),
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
      const productName = processedItems[0]?.productName || 'Musical Instrument';
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
    billingMonth?: string;
    paymentId?: string;
    monthIndex?: number;
    amount: number;
    paymentMethod?: string;
    transactionRef?: string;
    notes?: string;
    adjustNextMonth?: boolean;
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

    // Set the amount paid directly (prevent accidental compound multiplication on rapid duplicate requests)
    payment.amountPaid = input.amount;
    payment.paidAt = new Date();
    payment.paymentMethod = input.paymentMethod || 'UPI';
    payment.transactionRef = input.transactionRef?.trim() || payment.transactionRef;
    payment.notes = input.notes?.trim() || payment.notes;
    payment.status = payment.amountPaid >= payment.amountDue ? 'PAID' : 'DUE';
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
  if (payment.amountPaid > 0 && usage.customerEmail && usage.customerEmail.includes('@')) {
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
        console.error('[EMAIL_RECEIPT_ERROR] Failed to dispatch receipt email:', emailErr);
      });
    } catch (err) {
      console.error('[EMAIL_RECEIPT_PREP_ERROR]', err);
    }
  }

  return usage;
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

  // Recalculate totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  await usage.save();

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

  // Re-calculate totals
  usage.totalRentPaid = usage.monthlyPayments.reduce((acc, p) => acc + (p.amountPaid || 0), 0);
  usage.totalRentDue = usage.monthlyPayments.reduce(
    (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
    0
  );

  await usage.save();

  await logAudit({
    actor,
    action: 'RENTAL_MONTH_ADDED',
    entityType: 'InternalUsage',
    entityId: usage._id.toString(),
    afterState: { nextIndex, agreedRent, dueDate: newDueDate },
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
    const isReturnOverdue = u.expectedReturnDate && new Date(u.expectedReturnDate) < now;
    const unpaidMonths = (u.monthlyPayments || []).filter((p) => p.status !== 'PAID');
    const overdueMonths = unpaidMonths.filter((p) => new Date(p.dueDate) < now);

    // --- Deposit-mode rentals: surface months that need a deduction notice sent ---
    if ((u as any).depositMode) {
      const pendingNoticeDeductions = ((u as any).depositDeductions || []).filter(
        (d: any) => !d.noticeSent
      );
      if (pendingNoticeDeductions.length > 0) {
        const primaryItem = u.items && u.items.length > 0 ? u.items[0] : null;
        const prod = primaryItem?.product as any;
        const serialUnit = primaryItem?.serializedItemId as any;

        items.push({
          id: u._id.toString(),
          issueReference: u.issueReference,
          loanType: 'RENTAL_DEPOSIT',
          assignedPerson: u.assignedPerson,
          customerEmail: u.customerEmail,
          assignedPersonContact: u.assignedPersonContact,
          productName: prod?.name || 'Musical Instrument',
          assetId: serialUnit?.assetId || serialUnit?.manufacturerSerial,
          totalRentDue: 0,
          monthlyRent: u.monthlyRent || 0,
          depositBalance: (u as any).depositBalance ?? 0,
          depositExhausted: (u as any).depositExhausted ?? false,
          pendingNoticeDeductions,               // array of deductions awaiting notice
          nextDueDate: pendingNoticeDeductions[0]?.deductedAt,
          daysOverdue: 0,
          status: 'DEPOSIT_NOTICE_PENDING',
          billingMonth: pendingNoticeDeductions[0]?.billingMonth || 'Deposit Deduction',
          remindersSentCount: u.remindersSent?.length || 0,
          lastReminderSentAt: undefined,
        });
      }
      // Skip normal due logic for deposit-mode — customer doesn't owe separate rent
      continue;
    }

    const pendingRent =
      u.totalRentDue > 0
        ? u.totalRentDue
        : unpaidMonths.reduce(
            (acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)),
            0
          );

    // If there is no pending rent and return is not overdue, skip
    if (pendingRent <= 0 && !isReturnOverdue) {
      continue;
    }

    const isOverdue = isReturnOverdue || overdueMonths.length > 0;
    const oldestDue = overdueMonths[0] || unpaidMonths[0];
    const targetDueDate = oldestDue?.dueDate || u.expectedReturnDate;

    let daysOverdue = 0;
    if (targetDueDate && new Date(targetDueDate) < now) {
      daysOverdue = Math.max(
        1,
        Math.floor((now.getTime() - new Date(targetDueDate).getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    const dueAmount = pendingRent > 0 ? pendingRent : u.monthlyRent || 0;

    totalPendingAmount += dueAmount;
    if (isOverdue) {
      totalOverdueAmount += dueAmount;
      overdueCount++;
    } else {
      dueSoonCount++;
    }

    const primaryItem = u.items && u.items.length > 0 ? u.items[0] : null;
    const prod = primaryItem?.product as any;
    const serialUnit = primaryItem?.serializedItemId as any;

    const lastReminder =
      u.remindersSent && u.remindersSent.length > 0
        ? u.remindersSent[u.remindersSent.length - 1]
        : null;

    items.push({
      id: u._id.toString(),
      issueReference: u.issueReference,
      loanType: 'RENTAL',
      assignedPerson: u.assignedPerson,
      customerEmail: u.customerEmail,
      assignedPersonContact: u.assignedPersonContact,
      productName: prod?.name || 'Musical Instrument',
      assetId: serialUnit?.assetId || serialUnit?.manufacturerSerial,
      totalRentDue: dueAmount,
      monthlyRent: u.monthlyRent || 0,
      nextDueDate: targetDueDate,
      daysOverdue,
      status: isOverdue ? 'OVERDUE' : daysOverdue === 0 ? 'DUE' : 'UPCOMING',
      billingMonth: oldestDue?.billingMonth || 'Active Loan Cycle',
      remindersSentCount: u.remindersSent?.length || 0,
      lastReminderSentAt: lastReminder?.sentAt,
    });
  }

  // Also query active EMI Sales with pending installment dues
  const emiSales = await Sale.find({
    isEmi: true,
    totalEmiDue: { $gt: 0 },
    saleStatus: { $ne: 'CANCELLED' },
  })
    .populate('lineItems.product', 'name sku brand')
    .sort({ createdAt: 1 })
    .lean();

  for (const sale of emiSales) {
    const unpaidEmis = (sale.emiPayments || []).filter((p) => p.status !== 'PAID');
    const overdueEmis = unpaidEmis.filter((p) => new Date(p.dueDate) < now);

    const pendingEmi =
      sale.totalEmiDue > 0
        ? sale.totalEmiDue
        : unpaidEmis.reduce((acc, p) => acc + Math.max(0, p.amountDue - (p.amountPaid || 0)), 0);

    if (pendingEmi <= 0) continue;

    const isOverdue = overdueEmis.length > 0;
    const oldestDue = overdueEmis[0] || unpaidEmis[0];
    const targetDueDate = oldestDue?.dueDate || sale.createdAt;

    let daysOverdue = 0;
    if (targetDueDate && new Date(targetDueDate) < now) {
      daysOverdue = Math.max(
        1,
        Math.floor((now.getTime() - new Date(targetDueDate).getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    const dueAmount = pendingEmi;

    totalPendingAmount += dueAmount;
    if (isOverdue) {
      totalOverdueAmount += dueAmount;
      overdueCount++;
    } else {
      dueSoonCount++;
    }

    const prodNames = sale.lineItems?.map((li: any) => li.product?.name).filter(Boolean).join(', ') || 'Musical Equipment';
    const lastReminder =
      sale.remindersSent && sale.remindersSent.length > 0
        ? sale.remindersSent[sale.remindersSent.length - 1]
        : null;

    items.push({
      id: sale._id.toString(),
      issueReference: sale.invoiceNumber,
      loanType: 'EMI',
      assignedPerson: sale.customerName,
      customerEmail: sale.customerEmail,
      assignedPersonContact: sale.customerPhone,
      productName: prodNames,
      totalRentDue: dueAmount,
      monthlyRent: sale.monthlyEmiAmount || dueAmount,
      nextDueDate: targetDueDate,
      daysOverdue,
      status: isOverdue ? 'OVERDUE' : daysOverdue === 0 ? 'DUE' : 'UPCOMING',
      billingMonth: oldestDue?.billingMonth || 'Active EMI Plan',
      remindersSentCount: sale.remindersSent?.length || 0,
      lastReminderSentAt: lastReminder?.sentAt,
    });
  }

  // Sort items: OVERDUE first (descending daysOverdue), then DUE/UPCOMING
  items.sort((a, b) => {
    if (a.status === 'OVERDUE' && b.status !== 'OVERDUE') return -1;
    if (a.status !== 'OVERDUE' && b.status === 'OVERDUE') return 1;
    return b.daysOverdue - a.daysOverdue;
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
  if ((usage as any).depositExhausted) {
    throw new AppError(
      'Security deposit is fully exhausted. Customer must now pay rent directly.',
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

  const deductAmount = payment.amountDue;
  const balanceBefore = (usage as any).depositBalance as number;

  if (balanceBefore < deductAmount) {
    throw new AppError(
      `Insufficient deposit balance (₹${balanceBefore}) to cover rent of ₹${deductAmount}. Mark deposit as exhausted and switch to continuation mode.`,
      400,
      'INSUFFICIENT_DEPOSIT'
    );
  }

  const balanceAfter = balanceBefore - deductAmount;
  const nowExhausted = balanceAfter <= 0;

  // Mark this month as paid via deposit
  payment.amountPaid = deductAmount;
  payment.paidAt = new Date();
  payment.paymentMethod = 'DEPOSIT';
  payment.transactionRef = `DEP-DEDUCT-M${input.monthIndex}-${usage.issueReference}`;
  payment.status = 'PAID';
  payment.notes = (payment.notes ? payment.notes + ' | ' : '') + `Rent deducted from security deposit by ${actor.name}`;

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
    notes: input.notes?.trim(),
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
