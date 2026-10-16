import { Router, Request, Response, NextFunction } from 'express';
import {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  listSerializedItems,
  getSerializedItemHistory,
  createStockMovement,
} from '../services/inventoryService.js';
import { Product } from '../models/Product.js';
import { StockLocation } from '../models/StockLocation.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createProductSchema, updateProductSchema } from '../validators/index.js';
import { ROLES, MOVEMENT_TYPES } from '../config/constants.js';
import { logAudit } from '../services/auditService.js';

const router = Router();

// List products
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listProducts(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// List serialized items
router.get('/serialized-items', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listSerializedItems(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Get serialized item history
router.get(
  '/serialized-items/:assetId/history',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getSerializedItemHistory(req.params.assetId as string);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// Get product by ID
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await getProductById(req.params.id as string);
    res.json({ success: true, data: { product } });
  } catch (err) {
    next(err);
  }
});

// Create product (Superadmin only)
router.post(
  '/',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  validate(createProductSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await createProduct(req.body, req.user!);
      await logAudit({
        actor: req.user!,
        action: 'CREATE_PRODUCT',
        entityType: 'Product',
        entityId: product._id.toString(),
        afterState: { name: product.name, sku: product.sku, trackingMode: product.trackingMode },
        reason: 'Added new product catalogue item',
      });
      res.status(201).json({ success: true, data: { product } });
    } catch (err) {
      next(err);
    }
  }
);

// Update product (Superadmin only)
router.patch(
  '/:id',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  validate(updateProductSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await updateProduct(req.params.id as string, req.body, req.user!);
      await logAudit({
        actor: req.user!,
        action: 'UPDATE_PRODUCT',
        entityType: 'Product',
        entityId: product._id.toString(),
        afterState: req.body,
        reason: 'Updated product catalogue item',
      });
      res.json({ success: true, data: { product } });
    } catch (err) {
      next(err);
    }
  }
);

// Quick Stock Count Adjustment (Manager & Superadmin)
router.post(
  '/:id/adjust-stock',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { newQuantity, reason } = req.body;
      if (typeof newQuantity !== 'number' || newQuantity < 0) {
        return res.status(400).json({ success: false, message: 'Quantity must be a valid non-negative number.' });
      }
      const product = await Product.findById(req.params.id);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
      }

      const oldQty = product.stockQuantity.onHand;
      const diff = newQuantity - oldQty;
      product.stockQuantity.onHand = newQuantity;

      // Update location stock if configured
      let defaultLoc = (await StockLocation.findOne({ isDefault: true }))?._id;
      if (product.locationStock && product.locationStock.length > 0) {
        product.locationStock[0].onHand = Math.max(0, product.locationStock[0].onHand + diff);
        defaultLoc = product.locationStock[0].location;
      }

      await product.save();

      if (defaultLoc && diff !== 0) {
        await createStockMovement({
          product: product._id,
          location: defaultLoc,
          movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
          quantityDelta: diff,
          sourceStatus: 'AVAILABLE',
          destinationStatus: 'AVAILABLE',
          transactionRef: `ADJ-DIRECT-${Date.now()}`,
          transactionModel: 'InventoryAdjustment',
          reason: reason || 'Direct stock count update from inventory catalogue',
          performedBy: req.user!.id,
        });
      }

      await logAudit({
        actor: req.user!,
        action: 'UPDATE_STOCK',
        entityType: 'Product',
        entityId: product._id.toString(),
        beforeState: { onHand: oldQty },
        afterState: { onHand: newQuantity },
        reason: reason || 'Direct stock count update',
      });

      res.json({ success: true, data: { product } });
    } catch (err) {
      next(err);
    }
  }
);

// Delete / Deactivate Product (Superadmin only)
router.delete(
  '/:id',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
      }
      product.isActive = false;
      await product.save();

      await logAudit({
        actor: req.user!,
        action: 'DELETE_PRODUCT',
        entityType: 'Product',
        entityId: product._id.toString(),
        beforeState: { name: product.name, sku: product.sku },
        reason: 'Deactivated product catalogue item',
      });

      res.json({ success: true, message: 'Product removed from catalogue.' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
