import mongoose, { Schema } from 'mongoose';
import { USAGE_PURPOSES, USAGE_STATUSES, ITEM_CONDITIONS, } from '../config/constants.js';
const UsageItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityIssued: { type: Number, required: true, min: 1 },
    quantityReturned: { type: Number, default: 0, min: 0 },
    serializedItemId: { type: Schema.Types.ObjectId, ref: 'SerializedItem' },
    issueCondition: {
        type: String,
        enum: Object.values(ITEM_CONDITIONS),
        default: ITEM_CONDITIONS.GOOD,
        required: true,
    },
}, { _id: false });
const InternalUsageSchema = new Schema({
    issueReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    purpose: {
        type: String,
        enum: Object.values(USAGE_PURPOSES),
        required: true,
    },
    customPurposeDetail: { type: String, trim: true },
    assignedPerson: { type: String, required: true, trim: true },
    assignedPersonContact: { type: String, trim: true },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    items: [UsageItemSchema],
    issueDate: { type: Date, default: Date.now },
    expectedReturnDate: { type: Date, required: true },
    actualReturnDate: { type: Date },
    status: {
        type: String,
        enum: Object.values(USAGE_STATUSES),
        default: USAGE_STATUSES.ACTIVE,
        required: true,
    },
    notes: { type: String, trim: true },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    extensions: [
        {
            extendedDate: { type: Date, required: true },
            reason: { type: String, required: true },
            approvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
            createdAt: { type: Date, default: Date.now },
        },
    ],
}, { timestamps: true });
InternalUsageSchema.index({ status: 1, expectedReturnDate: 1 });
InternalUsageSchema.index({ assignedPerson: 'text' });
export const InternalUsage = mongoose.model('InternalUsage', InternalUsageSchema);
