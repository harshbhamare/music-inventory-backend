import { Router, Request, Response, NextFunction } from 'express';
import { StockMovement } from '../models/StockMovement.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// List stock movements with filter & pagination
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const query: any = {};
    if (req.query.movementType) {
      query.movementType = req.query.movementType;
    }
    if (req.query.product) {
      query.product = req.query.product;
    }
    if (req.query.location) {
      query.location = req.query.location;
    }
    if (req.query.search) {
      const searchRegex = new RegExp((req.query.search as string).trim(), 'i');
      query.$or = [{ transactionRef: searchRegex }, { reason: searchRegex }];
    }

    const [movements, total] = await Promise.all([
      StockMovement.find(query)
        .populate('product', 'name sku brand trackingMode')
        .populate('serializedItem', 'assetId manufacturerSerial')
        .populate('location', 'name code')
        .populate('performedBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        movements,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
