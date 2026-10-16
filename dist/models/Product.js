import mongoose, { Schema } from 'mongoose';
import { TRACKING_MODES } from '../config/constants.js';
const LocationStockSchema = new Schema({
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    issuedInternal: { type: Number, default: 0, min: 0 },
    quarantined: { type: Number, default: 0, min: 0 },
}, { _id: false });
const ProductSchema = new Schema({
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    brand: { type: String, required: true, trim: true },
    modelName: { type: String, trim: true },
    description: { type: String, trim: true },
    trackingMode: {
        type: String,
        enum: Object.values(TRACKING_MODES),
        default: TRACKING_MODES.QUANTITY,
        required: true,
    },
    unitOfMeasure: { type: String, default: 'pcs', trim: true },
    purchaseCost: { type: Number, required: true, min: 0 },
    defaultSellingPrice: { type: Number, required: true, min: 0 },
    supplier: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    minStockThreshold: { type: Number, default: 5, min: 0 },
    stockQuantity: {
        onHand: { type: Number, default: 0, min: 0 },
        reserved: { type: Number, default: 0, min: 0 },
        issuedInternal: { type: Number, default: 0, min: 0 },
        quarantined: { type: Number, default: 0, min: 0 },
    },
    locationStock: [LocationStockSchema],
    isActive: { type: Boolean, default: true },
    imageUrl: { type: String, trim: true },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});
// Virtual calculation for Available For Sale
ProductSchema.virtual('availableForSale').get(function () {
    const sq = this.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
    const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
    return Math.max(0, (sq.onHand || 0) - unavailable);
});
// Indexes for search and query performance
ProductSchema.index({ name: 'text', brand: 'text', modelName: 'text', sku: 'text' });
ProductSchema.index({ category: 1, trackingMode: 1, isActive: 1 });
export const Product = mongoose.model('Product', ProductSchema);
