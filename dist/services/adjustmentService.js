import { Types } from 'mongoose';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { AppSetting } from '../models/AppSetting.js';
import { ADJUSTMENT_STATUSES, TRACKING_MODES, SERIALIZED_STATUSES, MOVEMENT_TYPES, ROLES, } from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
export async function requestAdjustment(input, actor) {
    const setting = await AppSetting.findOne();
    const threshold = setting?.managerApprovalThresholdValue ?? 3;
    // Determine if manager approval is required
    let requiresApproval = false;
    if (actor.role === ROLES.INVENTORY_STAFF || actor.role === ROLES.SALES_STAFF) {
        requiresApproval = true;
    }
    else {
        // Check threshold or critical types (WRITE_OFF, DAMAGE_LOSS)
        for (const item of input.items) {
            if (Math.abs(item.quantityDelta) > threshold || input.type === 'WRITE_OFF' || item.serializedItem) {
                requiresApproval = true;
                break;
            }
        }
    }
    const count = await InventoryAdjustment.countDocuments();
    const year = new Date().getFullYear();
    const adjustmentReference = `ADJ-${year}-${String(count + 1).padStart(4, '0')}`;
    const adjustment = new InventoryAdjustment({
        adjustmentReference,
        location: new Types.ObjectId(input.location),
        type: input.type,
        reason: input.reason.trim(),
        supportingDocumentUrl: input.supportingDocumentUrl,
        items: input.items.map((i) => ({
            product: new Types.ObjectId(i.product),
            serializedItem: i.serializedItem ? new Types.ObjectId(i.serializedItem) : undefined,
            quantityDelta: i.quantityDelta,
            targetStatus: i.targetStatus,
            reason: i.reason.trim(),
        })),
        status: requiresApproval ? ADJUSTMENT_STATUSES.PENDING_APPROVAL : ADJUSTMENT_STATUSES.APPROVED,
        requestedBy: new Types.ObjectId(actor.id),
        requiresApproval,
        appliedMovementIds: [],
    });
    if (!requiresApproval) {
        // Immediate auto-approval for low-impact changes by managers
        adjustment.approvedBy = new Types.ObjectId(actor.id);
        adjustment.approvedAt = new Date();
        await applyAdjustmentMovements(adjustment, actor);
    }
    await adjustment.save();
    await logAudit({
        actor,
        action: 'REQUEST_INVENTORY_ADJUSTMENT',
        entityType: 'InventoryAdjustment',
        entityId: adjustment._id.toString(),
        afterState: { adjustmentReference, status: adjustment.status, requiresApproval },
        reason: `Inventory adjustment requested: ${input.reason}`,
    });
    return adjustment;
}
export async function reviewAdjustment(adjustmentId, action, rejectionReason, actor) {
    const adjustment = await InventoryAdjustment.findById(adjustmentId);
    if (!adjustment) {
        throw new AppError('Adjustment request not found.', 404, 'NOT_FOUND');
    }
    if (adjustment.status !== ADJUSTMENT_STATUSES.PENDING_APPROVAL) {
        throw new AppError(`Adjustment has already been reviewed (Current status: ${adjustment.status}).`, 400, 'ALREADY_REVIEWED');
    }
    // Enforce invariant: Requester must NOT approve their own adjustment
    if (adjustment.requestedBy.toString() === actor.id) {
        throw new AppError('Security rule violation: You cannot approve your own adjustment request.', 403, 'SELF_APPROVAL_FORBIDDEN');
    }
    if (action === 'REJECT') {
        adjustment.status = ADJUSTMENT_STATUSES.REJECTED;
        adjustment.rejectionReason = rejectionReason || 'Rejected by manager';
        adjustment.approvedBy = new Types.ObjectId(actor.id);
        adjustment.approvedAt = new Date();
        await adjustment.save();
        await logAudit({
            actor,
            action: 'REJECT_INVENTORY_ADJUSTMENT',
            entityType: 'InventoryAdjustment',
            entityId: adjustment._id.toString(),
            afterState: { status: adjustment.status, rejectionReason: adjustment.rejectionReason },
            reason: `Rejected adjustment: ${adjustment.rejectionReason}`,
        });
        return adjustment;
    }
    // Action is APPROVE: apply stock changes atomically exactly once
    await applyAdjustmentMovements(adjustment, actor);
    adjustment.status = ADJUSTMENT_STATUSES.APPROVED;
    adjustment.approvedBy = new Types.ObjectId(actor.id);
    adjustment.approvedAt = new Date();
    await adjustment.save();
    await logAudit({
        actor,
        action: 'APPROVE_INVENTORY_ADJUSTMENT',
        entityType: 'InventoryAdjustment',
        entityId: adjustment._id.toString(),
        afterState: { status: adjustment.status, appliedMovements: adjustment.appliedMovementIds.length },
        reason: `Approved adjustment ${adjustment.adjustmentReference}`,
    });
    return adjustment;
}
async function applyAdjustmentMovements(adjustment, actor) {
    if (adjustment.appliedMovementIds && adjustment.appliedMovementIds.length > 0) {
        throw new AppError('This adjustment has already been applied.', 400, 'ALREADY_APPLIED');
    }
    return await withTransaction(async (session) => {
        const appliedIds = [];
        for (const item of adjustment.items) {
            const product = await Product.findById(item.product).session(session);
            if (!product)
                throw new AppError(`Product ${item.product} not found.`, 404);
            if (product.trackingMode === TRACKING_MODES.SERIALIZED && item.serializedItem) {
                const serializedUnit = await SerializedItem.findById(item.serializedItem).session(session);
                if (!serializedUnit)
                    throw new AppError(`Serialized asset ${item.serializedItem} not found.`, 404);
                const oldStatus = serializedUnit.status;
                const newStatus = item.targetStatus || (item.quantityDelta < 0 ? SERIALIZED_STATUSES.RETIRED : SERIALIZED_STATUSES.AVAILABLE);
                serializedUnit.status = newStatus;
                await serializedUnit.save({ session });
                // Update product balances
                if (oldStatus === SERIALIZED_STATUSES.AVAILABLE && newStatus === SERIALIZED_STATUSES.RETIRED) {
                    product.stockQuantity.onHand = Math.max(0, product.stockQuantity.onHand - 1);
                }
                else if (oldStatus === SERIALIZED_STATUSES.AVAILABLE && newStatus === SERIALIZED_STATUSES.QUARANTINED) {
                    product.stockQuantity.quarantined += 1;
                }
                else if (oldStatus === SERIALIZED_STATUSES.QUARANTINED && newStatus === SERIALIZED_STATUSES.AVAILABLE) {
                    product.stockQuantity.quarantined = Math.max(0, product.stockQuantity.quarantined - 1);
                }
                await product.save({ session });
                const movement = await createStockMovement({
                    product: product._id,
                    serializedItem: serializedUnit._id,
                    location: adjustment.location,
                    movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
                    quantityDelta: item.quantityDelta,
                    sourceStatus: oldStatus,
                    destinationStatus: newStatus,
                    transactionRef: adjustment.adjustmentReference,
                    transactionModel: 'InventoryAdjustment',
                    reason: `Adjustment (${adjustment.type}): ${item.reason}`,
                    performedBy: actor.id,
                    idempotencyKey: `${adjustment.adjustmentReference}-${serializedUnit._id}`,
                }, session);
                appliedIds.push(movement._id);
            }
            else {
                // Quantity-based product adjustment
                const newOnHand = product.stockQuantity.onHand + item.quantityDelta;
                if (newOnHand < 0) {
                    throw new AppError(`Adjustment would cause negative on-hand balance for ${product.name}. Current: ${product.stockQuantity.onHand}, Delta: ${item.quantityDelta}`, 400, 'NEGATIVE_BALANCE_FORBIDDEN');
                }
                product.stockQuantity.onHand = newOnHand;
                let locStock = product.locationStock.find((ls) => ls.location.toString() === adjustment.location.toString());
                if (locStock) {
                    locStock.onHand = Math.max(0, locStock.onHand + item.quantityDelta);
                }
                await product.save({ session });
                const movement = await createStockMovement({
                    product: product._id,
                    location: adjustment.location,
                    movementType: MOVEMENT_TYPES.MANUAL_ADJUSTMENT,
                    quantityDelta: item.quantityDelta,
                    transactionRef: adjustment.adjustmentReference,
                    transactionModel: 'InventoryAdjustment',
                    reason: `Adjustment (${adjustment.type}): ${item.reason}`,
                    performedBy: actor.id,
                    idempotencyKey: `${adjustment.adjustmentReference}-${product._id}`,
                }, session);
                appliedIds.push(movement._id);
            }
        }
        adjustment.appliedMovementIds = appliedIds;
        await adjustment.save({ session });
    });
}
