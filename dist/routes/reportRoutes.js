import { Router } from 'express';
import { getDashboardMetrics, getInventoryValuationReport, getPeriodicSummary, generateCsv, } from '../services/reportService.js';
import { runInventoryReconciliation } from '../services/reconciliationService.js';
import { sendDailyStockSummary, sendOverdueUsageReminders, sendTestEmail, dispatchReportEmail, } from '../services/emailService.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { Sale } from '../models/Sale.js';
import { StockMovement } from '../models/StockMovement.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES } from '../config/constants.js';
const router = Router();
// Dashboard summary KPIs & charts
router.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
        let startDate;
        let endDate;
        if (req.query.startDate) {
            startDate = new Date(req.query.startDate);
        }
        if (req.query.endDate) {
            endDate = new Date(req.query.endDate);
        }
        const data = await getDashboardMetrics(startDate, endDate);
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
});
// Periodic summary (Weekly and Monthly breakdowns)
router.get('/periodic-summary', requireAuth, async (req, res, next) => {
    try {
        const period = req.query.period || 'week';
        const data = await getPeriodicSummary(period);
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
});
// Inventory valuation report
router.get('/valuation', requireAuth, async (_req, res, next) => {
    try {
        const data = await getInventoryValuationReport();
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
});
// Inventory reconciliation audit
router.get('/reconciliation', requireAuth, async (_req, res, next) => {
    try {
        const data = await runInventoryReconciliation();
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
});
// Comprehensive On-Demand Email Report Dispatch (Supports any report type and custom recipient email)
router.post('/send-email-report', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
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
    }
    catch (err) {
        console.error('[REPORT_DISPATCH_ERROR]', err);
        res.status(500).json({
            success: false,
            error: { message: err.message || 'Failed to dispatch report email.' },
        });
    }
});
// Trigger test email
router.post('/email-test', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const targetRecipient = (req.body.recipientEmail || req.body.email || req.user.email || '').trim();
        const log = await sendTestEmail(targetRecipient, `${req.user.name} (${req.user.role})`);
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
    }
    catch (err) {
        res.status(500).json({ success: false, error: { message: err.message || 'Failed to send test email.' } });
    }
});
// Trigger manual daily summary dispatch
router.post('/send-summary', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
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
    }
    catch (err) {
        res.status(500).json({ success: false, error: { message: err.message || 'Failed to send stock summary.' } });
    }
});
// Trigger overdue usage reminder dispatch
router.post('/send-overdue-reminders', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
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
    }
    catch (err) {
        res.status(500).json({ success: false, error: { message: err.message || 'Failed to send overdue reminders.' } });
    }
});
// List email delivery logs
router.get('/email-logs', requireAuth, async (_req, res, next) => {
    try {
        const logs = await EmailDeliveryLog.find().sort({ createdAt: -1 }).limit(50).lean();
        res.json({ success: true, data: { logs } });
    }
    catch (err) {
        next(err);
    }
});
// CSV export
router.get('/export/:type', requireAuth, async (req, res, next) => {
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
                    p.category?.name || 'Uncategorized',
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
                m.product?.name || 'N/A',
                m.product?.sku || 'N/A',
                m.quantityDelta,
                m.reason,
                m.performedBy?.name || 'System',
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
                s.soldBy?.name || 'Staff',
            ]);
            const csv = generateCsv(headers, rows);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=stereobliss-sales-${Date.now()}.csv`);
            res.send(csv);
            return;
        }
        if (type === 'periodic') {
            const period = req.query.period || 'week';
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
        res.status(400).json({ success: false, error: { message: 'Invalid export type.' } });
    }
    catch (err) {
        next(err);
    }
});
export default router;
