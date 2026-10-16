import { Router, Request, Response, NextFunction } from 'express';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { requestAdjustment, reviewAdjustment } from '../services/adjustmentService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { requestAdjustmentSchema, reviewAdjustmentSchema } from '../validators/index.js';
import { ROLES, ADJUSTMENT_STATUSES } from '../config/constants.js';

const router = Router();

// List adjustments
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query: any = {};
    if (req.query.status) {
      query.status = req.query.status;
    }

    const adjustments = await InventoryAdjustment.find(query)
      .populate('location', 'name code')
      .populate('items.product', 'name sku brand trackingMode')
      .populate('items.serializedItem', 'assetId manufacturerSerial status')
      .populate('requestedBy', 'name email role')
      .populate('approvedBy', 'name email role')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: { adjustments } });
  } catch (err) {
    next(err);
  }
});

// Request an adjustment (Manager & Superadmin)
router.post(
  '/',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  validate(requestAdjustmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adjustment = await requestAdjustment(req.body, req.user!);
      res.status(201).json({ success: true, data: { adjustment } });
    } catch (err) {
      next(err);
    }
  }
);

// Review (Approve or Reject) an adjustment (Superadmin only)
router.post(
  '/:id/review',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  validate(reviewAdjustmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adjustment = await reviewAdjustment(
        req.params.id as string,
        req.body.action,
        req.body.rejectionReason,
        req.user!
      );
      res.json({ success: true, data: { adjustment } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
