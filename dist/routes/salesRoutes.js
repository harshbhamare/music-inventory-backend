import { Router } from 'express';
import { Sale } from '../models/Sale.js';
import { CustomerReturn } from '../models/CustomerReturn.js';
import { createSale, updateSale, processSaleReturn, recordEmiPayment, sendEmiReminder } from '../services/salesService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createSaleSchema, updateSaleSchema, recordEmiPaymentSchema } from '../validators/index.js';
import { ROLES } from '../config/constants.js';
const router = Router();
// List sales
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
        const skip = (page - 1) * limit;
        const query = {};
        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            query.$or = [
                { invoiceNumber: searchRegex },
                { customerName: searchRegex },
                { customerPhone: searchRegex },
            ];
        }
        const [sales, total] = await Promise.all([
            Sale.find(query)
                .populate('location', 'name code')
                .populate('soldBy', 'name email')
                .populate('lineItems.product', 'name sku brand')
                .populate('paymentLogs.recordedBy', 'name email')
                .populate('remindersSent.sentBy', 'name email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Sale.countDocuments(query),
        ]);
        res.json({
            success: true,
            data: {
                sales,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// Get sale by ID / Invoice
router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const sale = await Sale.findById(req.params.id)
            .populate('location', 'name code address')
            .populate('soldBy', 'name email')
            .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice color')
            .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
            .populate('paymentLogs.recordedBy', 'name email')
            .populate('remindersSent.sentBy', 'name email')
            .lean();
        res.json({ success: true, data: { sale } });
    }
    catch (err) {
        next(err);
    }
});
// Download / View Tax Invoice PDF
router.get('/:id/pdf', requireAuth, async (req, res, next) => {
    try {
        const sale = await Sale.findById(req.params.id)
            .populate('location', 'name code address')
            .populate('soldBy', 'name email')
            .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice color')
            .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
            .lean();
        if (!sale) {
            return res.status(404).json({ success: false, message: 'Sale invoice not found.' });
        }
        const { generateTaxInvoicePdf } = await import('../services/pdfService.js');
        const pdfBuffer = await generateTaxInvoicePdf(sale);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=TaxInvoice-${sale.invoiceNumber}.pdf`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    }
    catch (err) {
        next(err);
    }
});
// Send Tax Invoice PDF via Email to Dealer or User
router.post('/:id/send-email', requireAuth, async (req, res, next) => {
    try {
        const sale = await Sale.findById(req.params.id)
            .populate('location', 'name code address')
            .populate('soldBy', 'name email')
            .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice color')
            .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
            .lean();
        if (!sale) {
            return res.status(404).json({ success: false, message: 'Sale invoice not found.' });
        }
        const targetRecipient = (req.body.recipientEmail || sale.customerEmail || '').trim();
        if (!targetRecipient || !targetRecipient.includes('@')) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid recipient email address for this dealer / customer.',
            });
        }
        const { sendInvoicePdfEmail } = await import('../services/emailService.js');
        const log = await sendInvoicePdfEmail({
            sale,
            recipientEmail: targetRecipient,
            customNotes: req.body.customNotes,
        });
        res.json({
            success: true,
            message: `Tax Invoice PDF dispatched to ${targetRecipient}`,
            data: { log, recipient: targetRecipient },
        });
    }
    catch (err) {
        next(err);
    }
});
// Create and confirm sale
router.post('/', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(createSaleSchema), async (req, res, next) => {
    try {
        const sale = await createSale(req.body, req.user);
        res.status(201).json({ success: true, data: { sale } });
    }
    catch (err) {
        next(err);
    }
});
// Process customer return
router.post('/:id/return', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const customerReturn = await processSaleReturn(req.params.id, req.body, req.user);
        res.status(201).json({ success: true, data: { return: customerReturn } });
    }
    catch (err) {
        next(err);
    }
});
// List customer returns
router.get('/returns/all', requireAuth, async (_req, res, next) => {
    try {
        const returns = await CustomerReturn.find()
            .populate('originalSale', 'invoiceNumber customerName')
            .populate('returnedItems.product', 'name sku brand')
            .populate('processedBy', 'name email')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { returns } });
    }
    catch (err) {
        next(err);
    }
});
// Update sale bill / invoice (Manager or Superadmin)
router.put('/:id', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(updateSaleSchema), async (req, res, next) => {
    try {
        const sale = await updateSale(req.params.id, req.body, req.user);
        const populated = await Sale.findById(sale._id)
            .populate('location', 'name code address')
            .populate('soldBy', 'name email')
            .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice color')
            .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
            .populate('paymentLogs.recordedBy', 'name email')
            .populate('remindersSent.sentBy', 'name email')
            .lean();
        res.json({ success: true, data: { sale: populated } });
    }
    catch (err) {
        next(err);
    }
});
// Record EMI monthly installment payment
router.post('/:id/emi-payments', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(recordEmiPaymentSchema), async (req, res, next) => {
    try {
        const sale = await recordEmiPayment(req.params.id, req.body, req.user);
        const populated = await Sale.findById(sale._id)
            .populate('location', 'name code address')
            .populate('soldBy', 'name email')
            .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice color')
            .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
            .populate('paymentLogs.recordedBy', 'name email')
            .populate('remindersSent.sentBy', 'name email')
            .lean();
        res.json({ success: true, data: { sale: populated } });
    }
    catch (err) {
        next(err);
    }
});
// Dispatch EMI payment reminder email
router.post('/:id/emi-reminders', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const result = await sendEmiReminder(req.params.id, req.user, req.body);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
