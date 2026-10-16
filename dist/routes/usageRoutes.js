import { Router } from 'express';
import { InternalUsage } from '../models/InternalUsage.js';
import { UsageReturn } from '../models/UsageReturn.js';
import { issueInstruments, returnInstruments, extendExpectedReturnDate, } from '../services/internalUsageService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { issueInternalUsageSchema, returnInternalUsageSchema, extendUsageSchema, } from '../validators/index.js';
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
router.post('/', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_STAFF), validate(issueInternalUsageSchema), async (req, res, next) => {
    try {
        const usage = await issueInstruments(req.body, req.user);
        res.status(201).json({ success: true, data: { usage } });
    }
    catch (err) {
        next(err);
    }
});
// Return equipment with condition inspection
router.post('/:id/return', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_STAFF), validate(returnInternalUsageSchema), async (req, res, next) => {
    try {
        const result = await returnInstruments(req.params.id, req.body, req.user);
        res.status(201).json({ success: true, data: { return: result } });
    }
    catch (err) {
        next(err);
    }
});
// Extend return date
router.post('/:id/extend', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER), validate(extendUsageSchema), async (req, res, next) => {
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
export default router;
