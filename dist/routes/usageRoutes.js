import { Router } from 'express';
import { InternalUsage } from '../models/InternalUsage.js';
import { UsageReturn } from '../models/UsageReturn.js';
import { issueInstruments, returnInstruments, extendExpectedReturnDate, recordRentalPayment, updateRentalPayment, adjustRentalMonthDue, addRentalMonth, sendRentalReminder, getRentalDuesSummary, sendBulkRentalReminders, } from '../services/internalUsageService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { issueInternalUsageSchema, returnInternalUsageSchema, extendUsageSchema, recordRentalPaymentSchema, updateRentalPaymentSchema, adjustRentalMonthDueSchema, addRentalMonthSchema, } from '../validators/index.js';
import { ROLES, USAGE_STATUSES } from '../config/constants.js';
const router = Router();
// List internal usage loans
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
        const skip = (page - 1) * limit;
        const query = {};
        if (req.query.status) {
            if (req.query.status === 'OVERDUE') {
                query.status = { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED] };
                query.expectedReturnDate = { $lt: new Date() };
            }
            else {
                query.status = req.query.status;
            }
        }
        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            query.$or = [{ issueReference: searchRegex }, { assignedPerson: searchRegex }];
        }
        const [usages, total] = await Promise.all([
            InternalUsage.find(query)
                .populate('location', 'name code')
                .populate('issuedBy', 'name email')
                .populate('items.product', 'name sku brand trackingMode')
                .populate('items.serializedItemId', 'assetId manufacturerSerial condition')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            InternalUsage.countDocuments(query),
        ]);
        // Compute isOverdue flag dynamically
        const now = new Date();
        const enriched = usages.map((u) => ({
            ...u,
            isOverdue: u.status !== USAGE_STATUSES.RETURNED && new Date(u.expectedReturnDate) < now,
        }));
        res.json({
            success: true,
            data: {
                usages: enriched,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// Get rental dues summary and active dues list for notification center & dashboard
router.get('/dues-summary', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (_req, res, next) => {
    try {
        const data = await getRentalDuesSummary();
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
});
// Dispatch batch reminders to overdue / due rentals
router.post('/bulk-reminders', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const result = await sendBulkRentalReminders(req.body.usageIds, req.user);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
// Get internal usage by ID
router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const usage = await InternalUsage.findById(req.params.id)
            .populate('location', 'name code')
            .populate('issuedBy', 'name email')
            .populate('items.product', 'name sku brand trackingMode')
            .populate('items.serializedItemId', 'assetId manufacturerSerial condition status')
            .populate('extensions.approvedBy', 'name email')
            .lean();
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Issue equipment for classes / practice / rehearsal
router.post('/', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(issueInternalUsageSchema), async (req, res, next) => {
    try {
        const usage = await issueInstruments(req.body, req.user);
        res.status(201).json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Return equipment with condition inspection
router.post('/:id/return', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(returnInternalUsageSchema), async (req, res, next) => {
    try {
        const result = await returnInstruments(req.params.id, req.body, req.user);
        res.status(201).json({ success: true, data: { return: result } });
    }
    catch (err) {
        next(err);
    }
});
// Extend return date
router.post('/:id/extend', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(extendUsageSchema), async (req, res, next) => {
    try {
        const usage = await extendExpectedReturnDate(req.params.id, req.body.extendedDate, req.body.reason, req.user);
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// List usage returns
router.get('/returns/all', requireAuth, async (_req, res, next) => {
    try {
        const returns = await UsageReturn.find()
            .populate('internalUsage', 'issueReference assignedPerson')
            .populate('items.product', 'name sku brand')
            .populate('items.serializedItemId', 'assetId manufacturerSerial')
            .populate('receivedBy', 'name email')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { returns } });
    }
    catch (err) {
        next(err);
    }
});
// Record monthly rental payment
router.post('/:id/payments', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(recordRentalPaymentSchema), async (req, res, next) => {
    try {
        const usage = await recordRentalPayment(req.params.id, req.body, req.user);
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Update specific rental payment / price / transaction reference
router.put('/:id/payments/:paymentId', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(updateRentalPaymentSchema), async (req, res, next) => {
    try {
        const usage = await updateRentalPayment(req.params.id, req.params.paymentId, req.body, req.user);
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Adjust scheduled rent amount due for a specific month
router.put('/:id/adjust-month-due', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(adjustRentalMonthDueSchema), async (req, res, next) => {
    try {
        const usage = await adjustRentalMonthDue(req.params.id, req.body, req.user);
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Add an additional month to the rental schedule
router.post('/:id/add-month', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(addRentalMonthSchema), async (req, res, next) => {
    try {
        const usage = await addRentalMonth(req.params.id, req.body, req.user);
        res.json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Send rental payment / overdue email reminder
router.post('/:id/send-reminder', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const result = await sendRentalReminder(req.params.id, req.user, {
            recipientEmail: req.body.recipientEmail,
            customNote: req.body.customNote,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
