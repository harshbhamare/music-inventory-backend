import mongoose, { Schema, Document, Types } from 'mongoose';
import { TRACKING_MODES, TrackingMode } from '../config/constants.js';

export interface ILocationStock {
  location: Types.ObjectId;
  onHand: number;
  reserved: number;
  issuedInternal: number;
  quarantined: number;
}

export interface IProduct extends Document {
  name: string;
  sku: string;
  category: Types.ObjectId;
  brand: string;
  modelName?: string;
  description?: string;
  trackingMode: TrackingMode;
  unitOfMeasure: string;
  purchaseCost: number;
  defaultSellingPrice: number;
  supplier?: Types.ObjectId;
  minStockThreshold: number;
  stockQuantity: {
    onHand: number;
    reserved: number;
    issuedInternal: number;
    quarantined: number;
  };
  locationStock: ILocationStock[];
  isActive: boolean;
  imageUrl?: string;
  availableForSale: number;
  createdAt: Date;
  updatedAt: Date;
}

const LocationStockSchema = new Schema<ILocationStock>(
  {
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    issuedInternal: { type: Number, default: 0, min: 0 },
    quarantined: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const ProductSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    brand: { type: String, required: false, default: 'StereoBliss', trim: true },
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
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual calculation for Available For Sale
ProductSchema.virtual('availableForSale').get(function (this: IProduct) {
  const sq = this.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
  const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
  return Math.max(0, (sq.onHand || 0) - unavailable);
});

// Indexes for search and query performance
ProductSchema.index({ name: 'text', brand: 'text', modelName: 'text', sku: 'text' });
ProductSchema.index({ category: 1, trackingMode: 1, isActive: 1 });

export const Product = mongoose.model<IProduct>('Product', ProductSchema);
