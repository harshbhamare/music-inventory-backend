import mongoose, { Types } from 'mongoose';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockMovement } from '../models/StockMovement.js';
import { StockLocation } from '../models/StockLocation.js';
import { TRACKING_MODES, SERIALIZED_STATUSES, MOVEMENT_TYPES, } from '../config/constants.js';
import { AppError } from '../middleware/errorHandler.js';
export async function listProducts(params) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
    const skip = (page - 1) * limit;
    const query = { isActive: true };
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
            { color: searchRegex },
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
    const items = products.map((p) => {
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
export async function getProductById(id) {
    const product = await Product.findById(id)
        .populate('category', 'name')
        .populate('supplier', 'name contactPerson email phone')
        .populate('locationStock.location', 'name code')
        .lean();
    if (!product) {
        throw new AppError('Product not found.', 404, 'NOT_FOUND');
    }
    const sq = product.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
    const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
    const available = Math.max(0, (sq.onHand || 0) - unavailable);
    return {
        ...product,
        availableForSale: available,
        isLowStock: available <= (product.minStockThreshold || 5),
    };
}
export async function getNextSku() {
    const products = await Product.find({}, { sku: 1 }).lean();
    let maxNum = 0;
    for (const p of products) {
        if (!p.sku)
            continue;
        const match = p.sku.match(/(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum)
                maxNum = num;
        }
    }
    const nextNum = maxNum + 1;
    return `SKU-${String(nextNum).padStart(4, '0')}`;
}
export async function createProduct(input, actor) {
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
        }
        else {
            throw new AppError(`A product with SKU ${input.sku} already exists.`, 409, 'DUPLICATE_SKU');
        }
    }
    const brand = (input.brand && input.brand.trim()) || 'Muziclub';
    const trackingMode = input.trackingMode || TRACKING_MODES.QUANTITY;
    const initialStock = Math.max(0, Number(input.initialStock) || 0);
    // Find or create default location for initial locationStock array
    const defaultLoc = (input.destinationLocation ? await StockLocation.findById(input.destinationLocation) : null) ||
        (await StockLocation.findOne({ isDefault: true })) ||
        (await StockLocation.findOne());
    const locationId = defaultLoc?._id;
    const product = await Product.create({
        name: input.name,
        sku,
        color: input.color?.trim() || undefined,
        category: input.category,
        brand,
        modelName: input.modelName?.trim() || undefined,
        description: input.description?.trim() || undefined,
        trackingMode,
        unitOfMeasure: input.unitOfMeasure || 'pcs',
        purchaseCost: input.purchaseCost,
        defaultSellingPrice: input.defaultSellingPrice,
        supplier: input.supplier || undefined,
        minStockThreshold: input.minStockThreshold !== undefined ? input.minStockThreshold : 5,
        imageUrl: input.imageUrl,
        stockQuantity: {
            onHand: initialStock,
            reserved: 0,
            issuedInternal: 0,
            quarantined: 0,
        },
        locationStock: locationId
            ? [
                {
                    location: locationId,
                    onHand: initialStock,
                    reserved: 0,
                    issuedInternal: 0,
                    quarantined: 0,
                },
            ]
            : [],
        isActive: true,
    });
    // If initial stock was provided, record initial stock movements and serialized units
    if (initialStock > 0 && locationId) {
        if (trackingMode === TRACKING_MODES.SERIALIZED) {
            const serialCount = await SerializedItem.countDocuments();
            const serials = input.initialSerialNumbers || [];
            for (let i = 0; i < initialStock; i++) {
                const assetId = `AST-${String(serialCount + i + 1).padStart(4, '0')}`;
                const mfgSerial = serials[i]?.trim().toUpperCase() || undefined;
                const serializedItem = await SerializedItem.create({
                    assetId,
                    manufacturerSerial: mfgSerial,
                    product: product._id,
                    unitCost: product.purchaseCost,
                    location: locationId,
                    status: SERIALIZED_STATUSES.AVAILABLE,
                    condition: 'NEW',
                    notes: 'Opening stock item',
                });
                await createStockMovement({
                    product: product._id,
                    serializedItem: serializedItem._id,
                    location: locationId,
                    movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
                    quantityDelta: 1,
                    destinationStatus: SERIALIZED_STATUSES.AVAILABLE,
                    transactionRef: `INIT-${product.sku}`,
                    transactionModel: 'Product',
                    reason: 'Initial opening stock intake',
                    performedBy: actor.id,
                });
            }
        }
        else {
            await createStockMovement({
                product: product._id,
                location: locationId,
                movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
                quantityDelta: initialStock,
                transactionRef: `INIT-${product.sku}`,
                transactionModel: 'Product',
                reason: 'Initial opening stock balance',
                performedBy: actor.id,
            });
        }
    }
    return product;
}
export async function updateProduct(id, updates, actor) {
    const product = await Product.findById(id);
    if (!product) {
        throw new AppError('Product not found.', 404, 'NOT_FOUND');
    }
    // Invariant: Prevent switching tracking mode if items or movements exist
    if (updates.trackingMode && updates.trackingMode !== product.trackingMode) {
        const totalOnHand = product.stockQuantity?.onHand || 0;
        const movementCount = await StockMovement.countDocuments({ product: product._id });
        if (totalOnHand > 0 || movementCount > 0) {
            throw new AppError('Cannot switch tracking mode when active stock or transaction history exists. A controlled stock migration is required.', 400, 'UNSAFE_TRACKING_MODE_CHANGE');
        }
    }
    Object.assign(product, updates);
    await product.save();
    return product;
}
export async function listSerializedItems(params) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 25));
    const skip = (page - 1) * limit;
    const query = {};
    if (params.product)
        query.product = params.product;
    if (params.status)
        query.status = params.status;
    if (params.condition)
        query.condition = params.condition;
    if (params.location)
        query.location = params.location;
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
export async function getSerializedItemHistory(assetIdOrItemId) {
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
export async function createStockMovement(data, session) {
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
