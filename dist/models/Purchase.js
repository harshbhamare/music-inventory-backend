import mongoose, { Schema } from 'mongoose';
import { PURCHASE_STATUSES } from '../config/constants.js';
const PurchaseLineItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityOrdered: { type: Number, required: true, min: 1 },
    quantityReceived: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
}, { _id: false });
const PurchaseSchema = new Schema({
    purchaseOrderNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    invoiceReference: { type: String, trim: true },
    orderDate: { type: Date, default: Date.now },
    lineItems: [PurchaseLineItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    additionalCosts: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        enum: Object.values(PURCHASE_STATUSES),
        default: PURCHASE_STATUSES.DRAFT,
        required: true,
    },
    destinationLocation: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
export const Purchase = mongoose.model('Purchase', PurchaseSchema);
