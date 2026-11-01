import { Router, Request, Response, NextFunction } from 'express';
import {
  getDashboardMetrics,
  getInventoryValuationReport,
  getPeriodicSummary,
  getRentalProfitabilityReport,
  generateCsv,
} from '../services/reportService.js';
import { runInventoryReconciliation } from '../services/reconciliationService.js';
import {
  sendDailyStockSummary,
  sendOverdueUsageReminders,
  sendNotificationEmail,
  sendTestEmail,
  dispatchReportEmail,
} from '../services/emailService.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { Product } from '../models/Product.js';
import { Sale } from '../models/Sale.js';
import { StockMovement } from '../models/StockMovement.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES, REPORT_TYPES } from '../config/constants.js';

const router = Router();

// Dashboard summary KPIs & charts
router.get('/dashboard', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (req.query.startDate) {
      startDate = new Date(req.query.startDate as string);
    }
    if (req.query.endDate) {
      endDate = new Date(req.query.endDate as string);
    }

    const data = await getDashboardMetrics(startDate, endDate);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Periodic summary (Weekly and Monthly breakdowns)
router.get('/periodic-summary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = (req.query.period as 'week' | 'month') || 'week';
    const data = await getPeriodicSummary(period);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Inventory valuation report
router.get('/valuation', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getInventoryValuationReport();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Inventory reconciliation audit
router.get('/reconciliation', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await runInventoryReconciliation();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Rental instrument profitability & fleet performance tracking
router.get('/rentals-profitability', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getRentalProfitabilityReport();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Comprehensive On-Demand Email Report Dispatch (Supports any report type and custom recipient email)
router.post(
  '/send-email-report',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportType = 'DAILY_STOCK_SUMMARY', recipientEmail, recipients, notes, customSubject } = req.body;
      const targetRecipient = (recipientEmail || recipients || req.user?.email || '').trim();

      if (!targetRecipient || !targetRecipient.includes('@')) {
        return res.status(400).json({
          success: false,
          error: { message: 'Please enter a valid recipient email address.' },
        });
      }

      console.log(`[REPORT_DISPATCH] Dispatching "${reportType}" to ${targetRecipient}...`);
      const log = await dispatchReportEmail(reportType, targetRecipient, {
        notes,
        customSubject,
        triggeredBy: `${req.user?.name} (${req.user?.role})`,
      });

      if (!log) {
        return res.status(500).json({
          success: false,
          error: { message: 'Failed to process report email dispatch.' },
        });
      }

      if (log.status === 'FAILED') {
        return res.status(500).json({
          success: false,
          error: {
            message: log.errorDetails || 'Email sending failed via SMTP. Please verify Gmail credentials.',
          },
          data: { log },
        });
      }

      res.json({
        success: true,
        message: `Email report (${reportType}) successfully dispatched to ${log.recipients.join(', ')}`,
        data: {
          log,
          recipients: log.recipients,
          messageId: log.providerReference,
          status: log.status,
        },
      });
    } catch (err: any) {
      console.error('[REPORT_DISPATCH_ERROR]', err);
      res.status(500).json({
        success: false,
        error: { message: err.message || 'Failed to dispatch report email.' },
      });
    }
  }
);

// Trigger test email
router.post(
  '/email-test',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetRecipient = (req.body.recipientEmail || req.body.email || req.user!.email || '').trim();

      const log = await sendTestEmail(targetRecipient, `${req.user!.name} (${req.user!.role})`);

      if (log && log.status === 'FAILED') {
        return res.status(500).json({
          success: false,
          error: { message: log.errorDetails || 'Failed to send test email.' },
          data: { log },
        });
      }

      res.json({
        success: true,
        message: `Test email successfully dispatched to ${targetRecipient}`,
        data: { log },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: { message: err.message || 'Failed to send test email.' } });
    }
  }
);

// Trigger manual daily summary dispatch
router.post(
  '/send-summary',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetRecipient = req.body.recipientEmail || req.body.recipients || req.user?.email;
      const log = await sendDailyStockSummary(targetRecipient, req.body.notes);

      if (log && log.status === 'FAILED') {
        return res.status(500).json({
          success: false,
          error: { message: log.errorDetails || 'Failed to send stock summary email.' },
          data: { log },
        });
      }

      res.json({ success: true, message: 'Stock summary email sent successfully', data: { log } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: { message: err.message || 'Failed to send stock summary.' } });
    }
  }
);

// Trigger overdue usage reminder dispatch
router.post(
  '/send-overdue-reminders',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetRecipient = req.body.recipientEmail || req.body.recipients || req.user?.email;
      const log = await sendOverdueUsageReminders(targetRecipient, req.body.notes);

      if (log && log.status === 'FAILED') {
        return res.status(500).json({
          success: false,
          error: { message: log.errorDetails || 'Failed to send overdue reminders email.' },
          data: { log },
        });
      }

      res.json({ success: true, message: 'Overdue reminders email sent successfully', data: { log } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: { message: err.message || 'Failed to send overdue reminders.' } });
    }
  }
);

// List email delivery logs
router.get('/email-logs', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const logs = await EmailDeliveryLog.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, data: { logs } });
  } catch (err) {
    next(err);
  }
});

// CSV export
router.get('/export/:type', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = req.params;

    if (type === 'products') {
      const products = await Product.find({ isActive: true }).populate('category', 'name').lean();
      const headers = ['Name', 'SKU', 'Brand', 'Category', 'Tracking Mode', 'On Hand', 'Reserved', 'In Use', 'Quarantined', 'Purchase Cost', 'Selling Price'];
      const rows = products.map((p) => {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        return [
          p.name,
          p.sku,
          p.brand,
          (p.category as any)?.name || 'Uncategorized',
          p.trackingMode,
          sq.onHand,
          sq.reserved,
          sq.issuedInternal,
          sq.quarantined,
          p.purchaseCost,
          p.defaultSellingPrice,
        ];
      });

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-products-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'movements') {
      const movements = await StockMovement.find()
        .populate('product', 'name sku')
        .populate('performedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean();

      const headers = ['Date', 'Reference', 'Type', 'Product', 'SKU', 'Quantity Delta', 'Reason', 'Performed By'];
      const rows = movements.map((m) => [
        new Date(m.createdAt).toISOString(),
        m.transactionRef,
        m.movementType,
        (m.product as any)?.name || 'N/A',
        (m.product as any)?.sku || 'N/A',
        m.quantityDelta,
        m.reason,
        (m.performedBy as any)?.name || 'System',
      ]);

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-movements-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'sales') {
      const sales = await Sale.find().populate('soldBy', 'name').sort({ createdAt: -1 }).lean();
      const headers = ['Invoice Number', 'Date', 'Customer Name', 'Payment Method', 'Payment Status', 'Subtotal', 'Discount', 'Grand Total', 'Sold By'];
      const rows = sales.map((s) => [
        s.invoiceNumber,
        new Date(s.createdAt).toISOString(),
        s.customerName,
        s.paymentMethod,
        s.paymentStatus,
        s.subtotal,
        s.discountTotal,
        s.grandTotal,
        (s.soldBy as any)?.name || 'Staff',
      ]);

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-sales-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'periodic') {
      const period = (req.query.period as 'week' | 'month') || 'week';
      const summary = await getPeriodicSummary(period);
      const headers = ['Period Label', 'Start Date', 'End Date', 'Sales Orders', 'Revenue (INR)', 'Units Sold', 'Purchases Received', 'Inward Value (INR)', 'Adjustments'];
      const rows = summary.periods.map((p) => [
        p.label,
        p.startDate.slice(0, 10),
        p.endDate.slice(0, 10),
        p.salesCount,
        p.salesRevenue,
        p.itemsSold,
        p.receiptsCount,
        p.receiptsValue,
        p.adjustmentsCount,
      ]);

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-${period}ly-summary-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'rentals') {
      const rentalReport = await getRentalProfitabilityReport();
      const headers = [
        'Agreement Ref',
        'Instrument Name',
        'SKU',
        'Serial / Asset ID',
        'Category',
        'Customer Name',
        'Phone',
        'Status',
        'Issue Date',
        'Expected Return',
        'Monthly Rent (INR)',
        'Deposit (INR)',
        'Total Rent Paid (INR)',
        'Rent Balance Due (INR)',
        'Asset Capex Cost (INR)',
        'Maintenance Cost (INR)',
        'Net Profit (INR)',
        'ROI (%)',
        'Capex Recovered',
      ];
      const rows = rentalReport.items.map((item) => [
        item.issueReference,
        item.productName,
        item.sku,
        item.assetId || item.serialNumber || 'N/A',
        item.category,
        item.customerName,
        item.customerContact || 'N/A',
        item.status,
        item.issueDate.slice(0, 10),
        item.expectedReturnDate.slice(0, 10),
        item.monthlyRent,
        item.securityDeposit,
        item.totalRentPaid,
        item.totalRentDue,
        item.purchaseCost,
        item.maintenanceCost,
        item.netProfit,
        `${item.roiPercent}%`,
        item.isCapexRecovered ? 'YES' : 'NO',
      ]);

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-rental-profitability-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'reconciliation') {
      const recon = await runInventoryReconciliation();
      const headers = [
        'Product Name',
        'SKU',
        'Tracking Mode',
        'Recorded On Hand',
        'Calculated from Ledger',
        'Physical Serial Count',
        'Variance (Delta)',
        'Audit Status',
        'Recommended Corrective Action',
      ];
      const rows = recon.results.map((r) => [
        r.productName,
        r.sku,
        r.trackingMode,
        r.recordedOnHand,
        r.calculatedFromLedger,
        r.serializedPhysicalCount ?? 'N/A',
        r.variance,
        r.status,
        r.recommendedAction,
      ]);

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-ledger-reconciliation-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    if (type === 'executive') {
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      if (req.query.startDate) startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) endDate = new Date(req.query.endDate as string);

      const data = await getDashboardMetrics(startDate, endDate);
      const ef = data.executiveFinancials;
      const fh = data.financialHealth;
      const ih = data.inventoryHealth;
      const rp = data.rentalPerformance;

      const headers = ['Domain', 'Metric Name', 'Recorded Value (INR / Units)', 'Previous Period Value', 'Change (%)', 'Definition & Accounting Basis'];
      const rows = [
        ['Executive Financials', 'Sales Revenue', ef.salesRevenue.value, ef.salesRevenue.previousValue, `${ef.salesRevenue.deltaPercent}% (${ef.salesRevenue.direction})`, ef.salesRevenue.definition],
        ['Executive Financials', 'Cash Collected', ef.cashCollected.value, ef.cashCollected.previousValue, `${ef.cashCollected.deltaPercent}% (${ef.cashCollected.direction})`, ef.cashCollected.definition],
        ['Executive Financials', 'Gross Profit', ef.grossProfit.value, ef.grossProfit.previousValue, `${ef.grossProfit.deltaPercent}% (${ef.grossProfit.direction})`, ef.grossProfit.definition],
        ['Executive Financials', 'Gross Margin %', `${ef.grossProfit.marginPercent}%`, `${ef.grossProfit.previousMarginPercent}%`, 'N/A', 'Gross Profit expressed as a percentage of Recognized Sales Revenue'],
        ['Executive Financials', 'Outstanding Receivables', ef.outstandingReceivables.value, ef.outstandingReceivables.previousValue, '0%', ef.outstandingReceivables.definition],
        ['Executive Financials', 'Inventory Value at Cost', ef.inventoryValuationAtCost.value, ef.inventoryValuationAtCost.previousValue, '0%', ef.inventoryValuationAtCost.definition],
        ['Executive Financials', 'Net Rental Profit', ef.netRentalProfit.value, ef.netRentalProfit.previousValue, `${ef.netRentalProfit.deltaPercent}% (${ef.netRentalProfit.direction})`, ef.netRentalProfit.definition],
        ['Financial Health', 'Period Inflows', fh.cashInflows, 'N/A', 'N/A', 'Liquid cash receipts from POS sales, EMI payments, and rental collections'],
        ['Financial Health', 'Period Outflows', fh.cashOutflows, 'N/A', 'N/A', 'Cash disbursements for inventory purchases and equipment maintenance'],
        ['Financial Health', 'Net Cash Movement', fh.netCashMovement, 'N/A', 'N/A', 'Cash Inflows minus Cash Outflows during the reporting period'],
        ['Financial Health', 'Customer Deposits Held', fh.customerDepositsHeld, 'N/A', 'N/A', 'Security deposits held in trust (Current Liability, strictly excluded from revenue)'],
        ['Financial Health', 'Refunds Payable', fh.refundsPayable, 'N/A', 'N/A', 'Deposit refund liabilities owed to customers for returned rental equipment'],
        ['Inventory Health', 'Total Units Owned', ih.totalUnitsOwned, 'N/A', 'N/A', 'Total physical instrument and accessory units owned by the company'],
        ['Inventory Health', 'Available for Sale', ih.totalAvailableForSale, 'N/A', 'N/A', 'Units in warehouse ready for retail sale (excluding rented/maintenance)'],
        ['Inventory Health', 'Currently on Rent', ih.totalUnitsInRental, 'N/A', 'N/A', 'Units currently issued out on active customer rental contracts'],
        ['Inventory Health', 'In Maintenance', ih.totalUnitsInMaintenance, 'N/A', 'N/A', 'Units quarantined in workshop undergoing inspection or repair'],
        ['Rental Fleet', 'Active Agreements', rp.activeAgreements, 'N/A', 'N/A', 'Active customer subscription and loan agreements'],
        ['Rental Fleet', 'Fleet Capex Recovery %', `${rp.fleetCapexRecoveryPercent}%`, 'N/A', 'N/A', 'Total all-time net rental income as a percentage of fleet acquisition cost'],
      ];

      const csv = generateCsv(headers, rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=stereobliss-executive-summary-${Date.now()}.csv`);
      res.send(csv);
      return;
    }

    res.status(400).json({ success: false, error: { message: 'Invalid export type.' } });
  } catch (err) {
    next(err);
  }
});

export default router;
