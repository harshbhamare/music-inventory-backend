import mongoose, { Schema } from 'mongoose';
import { ITEM_CONDITIONS } from '../config/constants.js';
const CustomerReturnItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    serializedItemIds: [{ type: Schema.Types.ObjectId, ref: 'SerializedItem' }],
    condition: {
        type: String,
        enum: Object.values(ITEM_CONDITIONS),
        default: ITEM_CONDITIONS.GOOD,
        required: true,
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    disposition: {
        type: String,
        enum: ['RETURN_TO_AVAILABLE', 'QUARANTINE_INSPECTION', 'MAINTENANCE'],
        default: 'QUARANTINE_INSPECTION',
        required: true,
    },
}, { _id: false });
const CustomerReturnSchema = new Schema({
    returnReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    originalSale: { type: Schema.Types.ObjectId, ref: 'Sale', required: true },
    returnedItems: [CustomerReturnItemSchema],
    totalRefundAmount: { type: Number, default: 0, min: 0 },
    reason: { type: String, required: true, trim: true },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
CustomerReturnSchema.index({ originalSale: 1 });
export const CustomerReturn = mongoose.model('CustomerReturn', CustomerReturnSchema);
