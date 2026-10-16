import { Router } from 'express';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { createPurchase, receivePurchase, quickReceiveStock } from '../services/purchaseService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createPurchaseSchema, receivePurchaseSchema } from '../validators/index.js';
import { ROLES } from '../config/constants.js';
const router = Router();
// Direct / Quick Stock Intake
router.post('/quick-receive', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), async (req, res, next) => {
    try {
        const result = await quickReceiveStock(req.body, req.user);
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
// List purchases
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const purchases = await Purchase.find()
            .populate('supplier', 'name contactPerson phone')
            .populate('destinationLocation', 'name code')
            .populate('lineItems.product', 'name sku brand')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { purchases } });
    }
    catch (err) {
        next(err);
    }
});
// Get purchase by ID
router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const purchase = await Purchase.findById(req.params.id)
            .populate('supplier', 'name contactPerson email phone address')
            .populate('destinationLocation', 'name code')
            .populate('lineItems.product', 'name sku brand trackingMode purchaseCost')
            .populate('createdBy', 'name email')
            .lean();
        res.json({ success: true, data: { purchase } });
    }
    catch (err) {
        next(err);
    }
});
// Create purchase order
router.post('/', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(createPurchaseSchema), async (req, res, next) => {
    try {
        const purchase = await createPurchase(req.body, req.user);
        res.status(201).json({ success: true, data: { purchase } });
    }
    catch (err) {
        next(err);
    }
});
// Receive goods against purchase order
router.post('/:id/receive', requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER), validate(receivePurchaseSchema), async (req, res, next) => {
    try {
        const receipt = await receivePurchase(req.params.id, req.body, req.user);
        res.status(201).json({ success: true, data: { receipt } });
    }
    catch (err) {
        next(err);
    }
});
// List receipts
router.get('/receipts/all', requireAuth, async (_req, res, next) => {
    try {
        const receipts = await PurchaseReceipt.find()
            .populate('purchase', 'purchaseOrderNumber invoiceReference')
            .populate('destinationLocation', 'name code')
            .populate('lineItems.product', 'name sku brand trackingMode')
            .populate('receivedBy', 'name email')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { receipts } });
    }
    catch (err) {
        next(err);
    }
});
export default router;
