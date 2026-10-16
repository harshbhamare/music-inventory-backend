import mongoose, { Schema } from 'mongoose';
import { ITEM_CONDITIONS } from '../config/constants.js';
export const INSPECTION_OUTCOMES = {
    OK_TO_STOCK: 'OK_TO_STOCK',
    NEEDS_MAINTENANCE: 'NEEDS_MAINTENANCE',
    QUARANTINE_DAMAGED: 'QUARANTINE_DAMAGED',
};
const ReturnLineItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityReturned: { type: Number, required: true, min: 1 },
    serializedItemId: { type: Schema.Types.ObjectId, ref: 'SerializedItem' },
    returnCondition: {
        type: String,
        enum: Object.values(ITEM_CONDITIONS),
        default: ITEM_CONDITIONS.GOOD,
        required: true,
    },
    inspectionOutcome: {
        type: String,
        enum: Object.values(INSPECTION_OUTCOMES),
        default: INSPECTION_OUTCOMES.OK_TO_STOCK,
        required: true,
    },
    inspectionNotes: { type: String, trim: true },
}, { _id: false });
const UsageReturnSchema = new Schema({
    returnReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    internalUsage: { type: Schema.Types.ObjectId, ref: 'InternalUsage', required: true },
    returnDate: { type: Date, default: Date.now },
    items: [ReturnLineItemSchema],
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    notes: { type: String, trim: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
UsageReturnSchema.index({ internalUsage: 1 });
export const UsageReturn = mongoose.model('UsageReturn', UsageReturnSchema);
