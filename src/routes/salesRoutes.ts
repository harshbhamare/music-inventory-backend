import { Router, Request, Response, NextFunction } from 'express';
import { Sale } from '../models/Sale.js';
import { CustomerReturn } from '../models/CustomerReturn.js';
import { createSale, processSaleReturn } from '../services/salesService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createSaleSchema } from '../validators/index.js';
import { ROLES } from '../config/constants.js';

const router = Router();

// List sales
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const query: any = {};
    if (req.query.search) {
      const searchRegex = new RegExp((req.query.search as string).trim(), 'i');
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
  } catch (err) {
    next(err);
  }
});

// Get sale by ID / Invoice
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .populate('location', 'name code address')
      .populate('soldBy', 'name email')
      .populate('lineItems.product', 'name sku brand modelName defaultSellingPrice')
      .populate('lineItems.serializedItemIds', 'assetId manufacturerSerial condition')
      .lean();

    res.json({ success: true, data: { sale } });
  } catch (err) {
    next(err);
  }
});

// Create and confirm sale
router.post(
  '/',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.SALES_STAFF),
  validate(createSaleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sale = await createSale(req.body, req.user!);
      res.status(201).json({ success: true, data: { sale } });
    } catch (err) {
      next(err);
    }
  }
);

// Process customer return
router.post(
  '/:id/return',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.SALES_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerReturn = await processSaleReturn(req.params.id as string, req.body, req.user!);
      res.status(201).json({ success: true, data: { return: customerReturn } });
    } catch (err) {
      next(err);
    }
  }
);

// List customer returns
router.get('/returns/all', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const returns = await CustomerReturn.find()
      .populate('originalSale', 'invoiceNumber customerName')
      .populate('returnedItems.product', 'name sku brand')
      .populate('processedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: { returns } });
  } catch (err) {
    next(err);
  }
});

export default router;
