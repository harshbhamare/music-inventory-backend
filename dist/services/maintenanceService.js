import { Types } from 'mongoose';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { MAINTENANCE_STATUSES, SERIALIZED_STATUSES, MOVEMENT_TYPES, ITEM_CONDITIONS, } from '../config/constants.js';
import { createStockMovement } from './inventoryService.js';
import { logAudit } from './auditService.js';
import { withTransaction } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';
export async function createMaintenance(input, actor) {
    const count = await MaintenanceRecord.countDocuments();
    const year = new Date().getFullYear();
    const recordReference = `MNT-${year}-${String(count + 1).padStart(4, '0')}`;
    const product = await Product.findById(input.product);
    if (!product)
        throw new AppError('Product not found.', 404);
    return await withTransaction(async (session) => {
        let serializedUnit = null;
        if (input.serializedItem) {
            serializedUnit = await SerializedItem.findById(input.serializedItem).session(session);
            if (!serializedUnit)
                throw new AppError('Serialized asset not found.', 404);
            if (serializedUnit.status === SERIALIZED_STATUSES.SOLD) {
                throw new AppError('Cannot place a sold instrument under internal maintenance.', 400, 'ASSET_SOLD');
            }
            const prevStatus = serializedUnit.status;
            serializedUnit.status = SERIALIZED_STATUSES.MAINTENANCE;
            await serializedUnit.save({ session });
            await createStockMovement({
                product: product._id,
                serializedItem: serializedUnit._id,
                location: input.location,
                movementType: MOVEMENT_TYPES.MAINTENANCE_OUT,
                quantityDelta: 0,
                sourceStatus: prevStatus,
                destinationStatus: SERIALIZED_STATUSES.MAINTENANCE,
                transactionRef: recordReference,
                transactionModel: 'MaintenanceRecord',
                reason: `Sent for maintenance: ${input.problemDescription}`,
                performedBy: actor.id,
            }, session);
        }
        const record = new MaintenanceRecord({
            recordReference,
            product: product._id,
            serializedItem: input.serializedItem ? new Types.ObjectId(input.serializedItem) : undefined,
            location: new Types.ObjectId(input.location),
            problemDescription: input.problemDescription.trim(),
            vendor: input.vendor?.trim(),
            cost: input.cost || 0,
            status: MAINTENANCE_STATUSES.IN_PROGRESS,
            startedAt: new Date(),
            createdByUser: new Types.ObjectId(actor.id),
            notes: input.notes,
        });
        await record.save({ session });
        await logAudit({
            actor,
            action: 'CREATE_MAINTENANCE_RECORD',
            entityType: 'MaintenanceRecord',
            entityId: record._id.toString(),
            afterState: { recordReference, problemDescription: input.problemDescription },
            reason: `Started maintenance/repair ticket`,
        });
        return record;
    });
}
export async function releaseMaintenance(recordId, input, actor) {
    const record = await MaintenanceRecord.findById(recordId);
    if (!record)
        throw new AppError('Maintenance record not found.', 404);
    if (record.status === MAINTENANCE_STATUSES.COMPLETED || record.status === MAINTENANCE_STATUSES.UNREPAIRABLE) {
        throw new AppError('This maintenance ticket is already closed.', 400, 'TICKET_ALREADY_CLOSED');
    }
    return await withTransaction(async (session) => {
        const product = await Product.findById(record.product).session(session);
        if (!product)
            throw new AppError('Product not found.', 404);
        if (record.serializedItem) {
            const serializedUnit = await SerializedItem.findById(record.serializedItem).session(session);
            if (!serializedUnit)
                throw new AppError('Serialized asset not found.', 404);
            const targetStatus = input.releaseDisposition;
            serializedUnit.status = targetStatus;
            if (targetStatus === 'AVAILABLE') {
                serializedUnit.condition = ITEM_CONDITIONS.GOOD;
            }
            await serializedUnit.save({ session });
            if (targetStatus === 'RETIRED') {
                product.stockQuantity.onHand = Math.max(0, product.stockQuantity.onHand - 1);
                await product.save({ session });
            }
            else if (targetStatus === 'QUARANTINED') {
                product.stockQuantity.quarantined += 1;
                await product.save({ session });
            }
            await createStockMovement({
                product: product._id,
                serializedItem: serializedUnit._id,
                location: record.location,
                movementType: MOVEMENT_TYPES.MAINTENANCE_IN,
                quantityDelta: targetStatus === 'RETIRED' ? -1 : 0,
                sourceStatus: SERIALIZED_STATUSES.MAINTENANCE,
                destinationStatus: targetStatus,
                transactionRef: record.recordReference,
                transactionModel: 'MaintenanceRecord',
                reason: `Released from maintenance: ${input.repairDetails} (Outcome: ${targetStatus})`,
                performedBy: actor.id,
            }, session);
        }
        record.status = input.releaseDisposition === 'RETIRED' ? MAINTENANCE_STATUSES.UNREPAIRABLE : MAINTENANCE_STATUSES.COMPLETED;
        record.completedAt = new Date();
        record.releasedByUser = new Types.ObjectId(actor.id);
        record.releaseDisposition = input.releaseDisposition;
        record.repairDetails = input.repairDetails;
        if (input.cost !== undefined)
            record.cost = input.cost;
        if (input.notes)
            record.notes = input.notes;
        await record.save({ session });
        await logAudit({
            actor,
            action: 'RELEASE_MAINTENANCE_RECORD',
            entityType: 'MaintenanceRecord',
            entityId: record._id.toString(),
            afterState: { recordReference: record.recordReference, disposition: input.releaseDisposition },
            reason: `Released item from maintenance as ${input.releaseDisposition}`,
        });
        return record;
    });
}
