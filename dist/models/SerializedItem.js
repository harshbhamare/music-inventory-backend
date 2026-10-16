import mongoose, { Schema } from 'mongoose';
import { SERIALIZED_STATUSES, ITEM_CONDITIONS, } from '../config/constants.js';
const SerializedItemSchema = new Schema({
    assetId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    manufacturerSerial: { type: String, uppercase: true, trim: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    purchaseReceipt: { type: Schema.Types.ObjectId, ref: 'PurchaseReceipt' },
    unitCost: { type: Number, required: true, min: 0 },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    status: {
        type: String,
        enum: Object.values(SERIALIZED_STATUSES),
        default: SERIALIZED_STATUSES.AVAILABLE,
        required: true,
    },
    condition: {
        type: String,
        enum: Object.values(ITEM_CONDITIONS),
        default: ITEM_CONDITIONS.NEW,
        required: true,
    },
    warrantyExpiry: { type: Date },
    currentUsage: { type: Schema.Types.ObjectId, ref: 'InternalUsage' },
    assignedTo: { type: String, trim: true },
    notes: { type: String, trim: true },
}, { timestamps: true });
// Indexes
SerializedItemSchema.index({ product: 1, status: 1 });
SerializedItemSchema.index({ location: 1, status: 1 });
SerializedItemSchema.index({ manufacturerSerial: 1 }, { unique: true, sparse: true });
export const SerializedItem = mongoose.model('SerializedItem', SerializedItemSchema);
