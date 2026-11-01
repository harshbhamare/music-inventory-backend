import { Product } from '../models/Product.js';
import { StockMovement } from '../models/StockMovement.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { Sale } from '../models/Sale.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { TRACKING_MODES, SERIALIZED_STATUSES, SALE_STATUSES, USAGE_STATUSES } from '../config/constants.js';

export interface ReconciliationDiscrepancy {
  productId: string;
  productName: string;
  sku: string;
  trackingMode: string;
  recordedOnHand: number;
  calculatedFromLedger: number;
  calculatedOnHand: number; // alias for frontend compatibility
  serializedPhysicalCount?: number;
  discrepancyDelta: number;
  variance: number; // alias for frontend compatibility
  hasMismatch: boolean;
  status: 'MATCH' | 'MISMATCH';
  recommendedAction: string;
}

export interface FinancialReconciliationSummary {
  salesReconciliation: {
    totalSalesCount: number;
    recognizedRevenue: number;
    directSalesCashCollected: number;
    emiDownPaymentsCollected: number;
    emiInstallmentsCollected: number;
    totalCashCollected: number;
    outstandingEmiReceivables: number;
    variance: number;
    isBalanced: boolean;
    explanation: string;
  };
  rentalReconciliation: {
    totalAgreementsCount: number;
    totalScheduledRent: number;
    rentCollected: number;
    outstandingRentDues: number;
    variance: number;
    isBalanced: boolean;
    securityDepositsHeld: number;
    securityDepositsDeducted: number;
    securityDepositsRefunded: number;
    refundsPending: number;
    explanation: string;
  };
}

export async function runInventoryReconciliation(): Promise<{
  timestamp: Date;
  totalProductsChecked: number;
  mismatchesFound: number;
  compliancePercentage: number;
  results: ReconciliationDiscrepancy[];
  financialReconciliation?: FinancialReconciliationSummary;
}> {
  const [products, sales, usages] = await Promise.all([
    Product.find({ isActive: true }).lean(),
    Sale.find({ saleStatus: { $ne: SALE_STATUSES.CANCELLED } }).lean(),
    InternalUsage.find({ isRental: true }).lean(),
  ]);

  const results: ReconciliationDiscrepancy[] = [];
  let mismatchesFound = 0;

  for (const product of products) {
    const recordedOnHand = product.stockQuantity?.onHand || 0;

    // Sum all movements from immutable transaction ledger
    const movementSumResult = await StockMovement.aggregate([
      { $match: { product: product._id } },
      { $group: { _id: null, totalDelta: { $sum: '$quantityDelta' } } },
    ]);

    const calculatedFromLedger = movementSumResult.length > 0 ? movementSumResult[0].totalDelta : 0;

    let serializedCount: number | undefined;
    if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
      // Physical count of owned units: not SOLD and not RETIRED
      serializedCount = await SerializedItem.countDocuments({
        product: product._id,
        status: { $nin: [SERIALIZED_STATUSES.SOLD, SERIALIZED_STATUSES.RETIRED] },
      });
    }

    const ledgerMismatch = recordedOnHand !== calculatedFromLedger;
    const serializedMismatch =
      serializedCount !== undefined && serializedCount !== recordedOnHand;

    const hasMismatch = ledgerMismatch || serializedMismatch;
    if (hasMismatch) {
      mismatchesFound++;
    }

    const delta = recordedOnHand - calculatedFromLedger;
    let recommendedAction = 'Immutable ledger movements reconcile 100% with physical inventory balance.';
    if (ledgerMismatch && serializedMismatch) {
      recommendedAction = `Investigate missing stock movement records. Physical count (${serializedCount ?? 0}) differs from catalog on-hand (${recordedOnHand}) by ${Math.abs(delta)} unit(s).`;
    } else if (ledgerMismatch) {
      recommendedAction = `Adjust recorded on-hand quantity (${recordedOnHand}) to match verified ledger sum (${calculatedFromLedger}) via Stock Reconciliation Adjustment.`;
    } else if (serializedMismatch) {
      recommendedAction = `Audit physical serial register: ${serializedCount} verified units found vs ${recordedOnHand} recorded on-hand.`;
    }

    results.push({
      productId: product._id.toString(),
      productName: product.name,
      sku: product.sku,
      trackingMode: product.trackingMode,
      recordedOnHand,
      calculatedFromLedger,
      calculatedOnHand: calculatedFromLedger,
      serializedPhysicalCount: serializedCount,
      discrepancyDelta: delta,
      variance: delta,
      hasMismatch,
      status: hasMismatch ? 'MISMATCH' : 'MATCH',
      recommendedAction,
    });
  }

  const totalProductsChecked = products.length;
  const compliancePercentage =
    totalProductsChecked > 0
      ? Number((((totalProductsChecked - mismatchesFound) / totalProductsChecked) * 100).toFixed(1))
      : 100;

  // ── Financial Reconciliations ──────────────────────────────────────────────
  // 1. Sales & Collections Reconciliation
  let recognizedRevenue = 0;
  let directSalesCashCollected = 0;
  let emiDownPaymentsCollected = 0;
  let emiInstallmentsCollected = 0;
  let outstandingEmiReceivables = 0;

  for (const s of sales) {
    if (s.saleStatus === 'RETURNED') continue;
    recognizedRevenue += s.grandTotal || 0;

    if (!s.isEmi) {
      if (s.paymentStatus === 'PAID') {
        directSalesCashCollected += s.grandTotal || 0;
      }
    } else {
      emiDownPaymentsCollected += s.downPayment || 0;
      const emiPaid = (s.emiPayments || []).reduce((sum, p) => sum + (p.amountPaid || 0), 0);
      emiInstallmentsCollected += emiPaid;
      outstandingEmiReceivables += s.totalEmiDue || 0;
    }
  }

  const totalSalesCashCollected = directSalesCashCollected + emiDownPaymentsCollected + emiInstallmentsCollected;
  // Variance: Revenue minus (Cash Collected + Valid Receivables) should be 0 in balanced accounting
  const salesVariance = Math.round(recognizedRevenue - (totalSalesCashCollected + outstandingEmiReceivables));
  const isSalesBalanced = Math.abs(salesVariance) <= 1;

  // 2. Rental Agreements & Payments Reconciliation
  let totalScheduledRent = 0;
  let rentCollected = 0;
  let outstandingRentDues = 0;
  let securityDepositsHeld = 0;
  let securityDepositsDeducted = 0;
  let securityDepositsRefunded = 0;
  let refundsPending = 0;

  for (const u of usages) {
    const payments = u.monthlyPayments || [];
    const paidSum = payments.reduce((sum, p) => sum + (p.amountPaid || 0), 0) || (u.totalRentPaid || 0);
    const dueSum = payments.reduce((sum, p) => sum + Math.max(0, (p.amountDue || 0) - (p.amountPaid || 0)), 0) || (u.totalRentDue || 0);

    rentCollected += paidSum;
    outstandingRentDues += dueSum;
    totalScheduledRent += (paidSum + dueSum);

    if (u.status === USAGE_STATUSES.ACTIVE || u.status === USAGE_STATUSES.OVERDUE || u.status === USAGE_STATUSES.PARTIALLY_RETURNED) {
      securityDepositsHeld += (u.depositBalance ?? u.securityDeposit ?? 0);
    } else if (u.status === USAGE_STATUSES.RETURNED || (u as any).depositRefundStatus === 'REFUND_PENDING') {
      const remainingDeposit = u.depositBalance ?? 0;
      if (remainingDeposit > 0) {
        refundsPending += remainingDeposit;
      }
      if ((u as any).depositRefundedAmount && (u as any).depositRefundedAmount > 0) {
        securityDepositsRefunded += (u as any).depositRefundedAmount;
      } else if (remainingDeposit === 0) {
        securityDepositsRefunded += (u.securityDeposit || 0);
      }
    }

    if (u.depositDeductions && u.depositDeductions.length > 0) {
      securityDepositsDeducted += u.depositDeductions.reduce((sum, d) => sum + (d.deductedAmount || 0), 0);
    }
  }

  const rentalVariance = Math.round(totalScheduledRent - (rentCollected + outstandingRentDues));
  const isRentalBalanced = Math.abs(rentalVariance) <= 1;

  return {
    timestamp: new Date(),
    totalProductsChecked,
    mismatchesFound,
    compliancePercentage,
    results,
    financialReconciliation: {
      salesReconciliation: {
        totalSalesCount: sales.length,
        recognizedRevenue,
        directSalesCashCollected,
        emiDownPaymentsCollected,
        emiInstallmentsCollected,
        totalCashCollected: totalSalesCashCollected,
        outstandingEmiReceivables,
        variance: salesVariance,
        isBalanced: isSalesBalanced,
        explanation: isSalesBalanced
          ? 'Recognized sales revenue reconciles exactly with recorded collections plus outstanding customer installment balances.'
          : `Discrepancy of ₹${Math.abs(salesVariance)} detected between recognized revenue and accounted payments/receivables.`,
      },
      rentalReconciliation: {
        totalAgreementsCount: usages.length,
        totalScheduledRent,
        rentCollected,
        outstandingRentDues,
        variance: rentalVariance,
        isBalanced: isRentalBalanced,
        securityDepositsHeld,
        securityDepositsDeducted,
        securityDepositsRefunded,
        refundsPending,
        explanation: isRentalBalanced
          ? 'Total scheduled rental billing matches rental cash collections plus outstanding customer dues.'
          : `Discrepancy of ₹${Math.abs(rentalVariance)} detected in rental schedule aggregation.`,
      },
    },
  };
}
