import { Router, Request, Response, NextFunction } from 'express';
import { Category } from '../models/Category.js';
import { Supplier } from '../models/Supplier.js';
import { StockLocation } from '../models/StockLocation.js';
import { AppSetting } from '../models/AppSetting.js';
import { AuditLog } from '../models/AuditLog.js';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { Product } from '../models/Product.js';
import { Purchase } from '../models/Purchase.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { Sale } from '../models/Sale.js';
import { StockMovement } from '../models/StockMovement.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { User } from '../models/User.js';
import { clearAllLocalData } from '../scripts/clean-data.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES, REPORT_TYPES } from '../config/constants.js';

const router = Router();

// Categories
router.get('/categories', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ name: 1 }).lean();
    res.json({ success: true, data: { categories } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/categories',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const category = await Category.create(req.body);
      res.status(201).json({ success: true, data: { category } });
    } catch (err) {
      next(err);
    }
  }
);

// Suppliers
router.get('/suppliers', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const suppliers = await Supplier.find({ isActive: true }).sort({ name: 1 }).lean();
    res.json({ success: true, data: { suppliers } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/suppliers',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await Supplier.create(req.body);
      res.status(201).json({ success: true, data: { supplier } });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/suppliers/:id',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER, ROLES.INVENTORY_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await Supplier.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true, runValidators: true }
      );
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found.' });
      }
      res.json({ success: true, data: { supplier } });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/suppliers/:id',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await Supplier.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { new: true }
      );
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found.' });
      }
      res.json({ success: true, message: 'Supplier removed successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// Locations
router.get('/locations', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const locations = await StockLocation.find({ isActive: true }).sort({ name: 1 }).lean();
    res.json({ success: true, data: { locations } });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/locations',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const location = await StockLocation.create(req.body);
      res.status(201).json({ success: true, data: { location } });
    } catch (err) {
      next(err);
    }
  }
);

// Settings
router.get('/settings', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let setting: any = await AppSetting.findOne().populate('defaultLocation', 'name code').lean();
    if (!setting) {
      const defaultLoc = await StockLocation.findOne({ isDefault: true }) || await StockLocation.findOne();
      setting = (
        await AppSetting.create({
          companyName: 'SoundStock Studio Academy & Store',
          contactEmail: 'contact@soundstock.io',
          defaultLocation: defaultLoc?._id,
        })
      ).toObject();
    }
    res.json({ success: true, data: { setting } });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/settings',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let setting = await AppSetting.findOne();
      if (!setting) {
        setting = new AppSetting(req.body);
      } else {
        Object.assign(setting, req.body);
      }
      await setting.save();
      res.json({ success: true, data: { setting } });
    } catch (err) {
      next(err);
    }
  }
);

// Email Report Configs
router.get(
  '/report-configs',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      let configs = await EmailReportConfig.find().lean();
      if (configs.length === 0) {
        // Seed default report configs
        await EmailReportConfig.create([
          {
            reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
            title: 'Daily Stock & Availability Summary',
            recipients: ['inventory@soundstock.io'],
            scheduleCron: '0 9 * * *',
            isEnabled: true,
          },
          {
            reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
            title: 'Weekly Sales Performance Summary',
            recipients: ['accounts@soundstock.io'],
            scheduleCron: '0 18 * * 0',
            isEnabled: true,
          },
          {
            reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
            title: 'Daily Overdue Instrument Loans Notice',
            recipients: ['academy@soundstock.io'],
            scheduleCron: '0 10 * * *',
            isEnabled: true,
          },
        ]);
        configs = await EmailReportConfig.find().lean();
      }
      res.json({ success: true, data: { configs } });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/report-configs/:id',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await EmailReportConfig.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
      });
      res.json({ success: true, data: { config } });
    } catch (err) {
      next(err);
    }
  }
);

// Audit Logs
router.get(
  '/audit-logs',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const skip = (page - 1) * limit;

      const query: any = {};
      if (req.query.action) query.action = req.query.action;
      if (req.query.entityType) query.entityType = req.query.entityType;

      const [logs, total] = await Promise.all([
        AuditLog.find(query)
          .populate('actor', 'name email role')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        AuditLog.countDocuments(query),
      ]);

      res.json({
        success: true,
        data: {
          logs,
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// System Info
router.get('/system-info', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      productsCount,
      serializedItemsCount,
      purchasesCount,
      receiptsCount,
      salesCount,
      movementsCount,
      usersCount,
    ] = await Promise.all([
      Product.countDocuments({ isActive: true }),
      SerializedItem.countDocuments(),
      Purchase.countDocuments(),
      PurchaseReceipt.countDocuments(),
      Sale.countDocuments(),
      StockMovement.countDocuments(),
      User.countDocuments(),
    ]);

    res.json({
      success: true,
      data: {
        counts: {
          products: productsCount,
          serializedItems: serializedItemsCount,
          purchases: purchasesCount,
          receipts: receiptsCount,
          sales: salesCount,
          movements: movementsCount,
          users: usersCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// Reset Temporary Data (Clean Database)
router.post(
  '/reset-data',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      console.log('[RESET] Initiating full system data cleanup...');
      await clearAllLocalData();
      res.json({
        success: true,
        message: 'All temporary data successfully wiped. System is clean and ready.',
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
