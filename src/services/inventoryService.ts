import mongoose, { ClientSession, Types } from 'mongoose';
import { Product, IProduct } from '../models/Product.js';
import { SerializedItem, ISerializedItem } from '../models/SerializedItem.js';
import { StockMovement, IStockMovement } from '../models/StockMovement.js';
import { StockLocation } from '../models/StockLocation.js';
import {
  TRACKING_MODES,
  SERIALIZED_STATUSES,
  MOVEMENT_TYPES,
  MovementType,
} from '../config/constants.js';
import { AppError } from '../middleware/errorHandler.js';
import { AuthenticatedUser } from '../middleware/auth.js';

export interface CreateProductInput {
  name: string;
  sku?: string;
  category: string;
  brand?: string;
  modelName?: string;
  description?: string;
  trackingMode?: 'QUANTITY' | 'SERIALIZED';
  unitOfMeasure?: string;
  purchaseCost: number;
  defaultSellingPrice: number;
  supplier?: string;
  minStockThreshold?: number;
  imageUrl?: string;
}

export interface ProductFilterParams {
  category?: string;
  trackingMode?: string;
  search?: string;
  lowStock?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export async function listProducts(params: ProductFilterParams) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
  const skip = (page - 1) * limit;

  const query: any = { isActive: true };

  if (params.category) {
    query.category = params.category;
  }

  if (params.trackingMode) {
    query.trackingMode = params.trackingMode;
  }

  if (params.search) {
    const searchRegex = new RegExp(params.search.trim(), 'i');
    query.$or = [
      { name: searchRegex },
      { sku: searchRegex },
      { brand: searchRegex },
      { modelName: searchRegex },
    ];
  }

  const sortField = params.sortBy || 'name';
  const sortDirection = params.sortOrder === 'desc' ? -1 : 1;

  const [products, total] = await Promise.all([
    Product.find(query)
      .populate('category', 'name')
      .populate('supplier', 'name')
      .sort({ [sortField]: sortDirection })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(query),
  ]);

  // Compute available and low-stock flag
  const items = products.map((p: any) => {
    const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
    const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
    const available = Math.max(0, (sq.onHand || 0) - unavailable);
    return {
      ...p,
      availableForSale: available,
      isLowStock: available <= (p.minStockThreshold || 5),
    };
  });

  return {
    items: params.lowStock ? items.filter((i) => i.isLowStock) : items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getProductById(id: string) {
  const product = await Product.findById(id)
    .populate('category', 'name')
    .populate('supplier', 'name contactPerson email phone')
    .populate('locationStock.location', 'name code')
    .lean();

  if (!product) {
    throw new AppError('Product not found.', 404, 'NOT_FOUND');
  }

  const sq = (product as any).stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
  const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
  const available = Math.max(0, (sq.onHand || 0) - unavailable);

  return {
    ...product,
    availableForSale: available,
    isLowStock: available <= (product.minStockThreshold || 5),
  };
}

export async function getNextSku(): Promise<string> {
  const products = await Product.find({}, { sku: 1 }).lean();
  let maxNum = 0;
  for (const p of products) {
    if (!p.sku) continue;
    const match = p.sku.match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  const nextNum = maxNum + 1;
  return `SKU-${String(nextNum).padStart(4, '0')}`;
}

export async function createProduct(input: CreateProductInput, actor: AuthenticatedUser) {
  let sku = input.sku ? input.sku.toUpperCase().trim() : '';
  if (!sku || sku === 'AUTO') {
    sku = await getNextSku();
  }

  // Ensure unique auto-increment if collision
  let existing = await Product.findOne({ sku });
  if (existing) {
    if (!input.sku || input.sku === 'AUTO') {
      let candidateNum = parseInt(sku.replace(/\D/g, ''), 10) || 1;
      while (await Product.findOne({ sku })) {
        candidateNum++;
        sku = `SKU-${String(candidateNum).padStart(4, '0')}`;
      }
    } else {
      throw new AppError(`A product with SKU ${input.sku} already exists.`, 409, 'DUPLICATE_SKU');
    }
  }

  const brand = (input.brand && input.brand.trim()) || 'StereoBliss';
  const trackingMode = input.trackingMode || TRACKING_MODES.QUANTITY;

  // Find or create default location for initial locationStock array
  const defaultLoc = await StockLocation.findOne({ isDefault: true }) || await StockLocation.findOne();

  const product = await Product.create({
    ...input,
    sku,
    brand,
    trackingMode,
    stockQuantity: {
      onHand: 0,
      reserved: 0,
      issuedInternal: 0,
      quarantined: 0,
    },
    locationStock: defaultLoc
      ? [
          {
            location: defaultLoc._id,
            onHand: 0,
            reserved: 0,
            issuedInternal: 0,
            quarantined: 0,
          },
        ]
      : [],
    isActive: true,
  });

  return product;
}

export async function updateProduct(id: string, updates: Partial<CreateProductInput>, actor: AuthenticatedUser) {
  const product = await Product.findById(id);
  if (!product) {
    throw new AppError('Product not found.', 404, 'NOT_FOUND');
  }

  // Invariant: Prevent switching tracking mode if items or movements exist
  if (updates.trackingMode && updates.trackingMode !== product.trackingMode) {
    const totalOnHand = product.stockQuantity?.onHand || 0;
    const movementCount = await StockMovement.countDocuments({ product: product._id });
    if (totalOnHand > 0 || movementCount > 0) {
      throw new AppError(
        'Cannot switch tracking mode when active stock or transaction history exists. A controlled stock migration is required.',
        400,
        'UNSAFE_TRACKING_MODE_CHANGE'
      );
    }
  }

  Object.assign(product, updates);
  await product.save();
  return product;
}

export async function listSerializedItems(params: {
  product?: string;
  status?: string;
  condition?: string;
  location?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(params.limit) || 25));
  const skip = (page - 1) * limit;

  const query: any = {};
  if (params.product) query.product = params.product;
  if (params.status) query.status = params.status;
  if (params.condition) query.condition = params.condition;
  if (params.location) query.location = params.location;

  if (params.search) {
    const searchRegex = new RegExp(params.search.trim(), 'i');
    query.$or = [
      { assetId: searchRegex },
      { manufacturerSerial: searchRegex },
      { assignedTo: searchRegex },
      { notes: searchRegex },
    ];
  }

  const [items, total] = await Promise.all([
    SerializedItem.find(query)
      .populate('product', 'name sku brand modelName defaultSellingPrice purchaseCost')
      .populate('location', 'name code')
      .populate('currentUsage', 'issueReference assignedPerson expectedReturnDate')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SerializedItem.countDocuments(query),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getSerializedItemHistory(assetIdOrItemId: string) {
  let item = await SerializedItem.findOne({
    $or: [
      { assetId: assetIdOrItemId.toUpperCase().trim() },
      ...(mongoose.isValidObjectId(assetIdOrItemId) ? [{ _id: assetIdOrItemId }] : []),
    ],
  })
    .populate('product', 'name sku brand modelName defaultSellingPrice purchaseCost')
    .populate('location', 'name code')
    .populate('currentUsage', 'issueReference assignedPerson expectedReturnDate purpose')
    .lean();

  if (!item) {
    throw new AppError('Serialized item not found.', 404, 'NOT_FOUND');
  }

  const movements = await StockMovement.find({ serializedItem: item._id })
    .populate('performedBy', 'name email role')
    .populate('location', 'name code')
    .sort({ createdAt: -1 })
    .lean();

  return {
    item,
    movements,
  };
}

export async function createStockMovement(
  data: {
    product: Types.ObjectId | string;
    serializedItem?: Types.ObjectId | string;
    location: Types.ObjectId | string;
    movementType: MovementType;
    quantityDelta: number;
    sourceStatus?: string;
    destinationStatus?: string;
    transactionRef: string;
    transactionModel: string;
    reason: string;
    performedBy: Types.ObjectId | string;
    idempotencyKey?: string;
  },
  session?: ClientSession | null
): Promise<IStockMovement> {
  const movement = new StockMovement({
    product: new Types.ObjectId(data.product),
    serializedItem: data.serializedItem ? new Types.ObjectId(data.serializedItem) : undefined,
    location: new Types.ObjectId(data.location),
    movementType: data.movementType,
    quantityDelta: data.quantityDelta,
    sourceStatus: data.sourceStatus,
    destinationStatus: data.destinationStatus,
    transactionRef: data.transactionRef,
    transactionModel: data.transactionModel,
    reason: data.reason,
    performedBy: new Types.ObjectId(data.performedBy),
    idempotencyKey: data.idempotencyKey,
  });

  await movement.save({ session });
  return movement;
}
