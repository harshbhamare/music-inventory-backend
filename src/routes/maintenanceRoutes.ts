import { Router, Request, Response, NextFunction } from 'express';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { createMaintenance, releaseMaintenance } from '../services/maintenanceService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createMaintenanceSchema, releaseMaintenanceSchema } from '../validators/index.js';
import { ROLES } from '../config/constants.js';

const router = Router();

// List maintenance records
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query: any = {};
    if (req.query.status) {
      query.status = req.query.status;
    }

    const records = await MaintenanceRecord.find(query)
      .populate('product', 'name sku brand modelName defaultSellingPrice')
      .populate('serializedItem', 'assetId manufacturerSerial condition')
      .populate('location', 'name code')
      .populate('createdByUser', 'name email')
      .populate('releasedByUser', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: { records } });
  } catch (err) {
    next(err);
  }
});

// Create maintenance ticket
router.post(
  '/',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_STAFF),
  validate(createMaintenanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await createMaintenance(req.body, req.user!);
      res.status(201).json({ success: true, data: { record } });
    } catch (err) {
      next(err);
    }
  }
);

// Release from maintenance
router.post(
  '/:id/release',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  validate(releaseMaintenanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await releaseMaintenance(req.params.id as string, req.body, req.user!);
      res.json({ success: true, data: { record } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
