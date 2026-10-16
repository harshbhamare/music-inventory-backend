import mongoose, { Schema, Document, Types } from 'mongoose';
import { PURCHASE_STATUSES, PurchaseStatus } from '../config/constants.js';

export interface IPurchaseLineItem {
  product: Types.ObjectId;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  totalCost: number;
}

export interface IPurchase extends Document {
  purchaseOrderNumber: string;
  supplier: Types.ObjectId;
  invoiceReference?: string;
  orderDate: Date;
  lineItems: IPurchaseLineItem[];
  subtotal: number;
  additionalCosts: number;
  totalCost: number;
  status: PurchaseStatus;
  destinationLocation: Types.ObjectId;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PurchaseLineItemSchema = new Schema<IPurchaseLineItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityOrdered: { type: Number, required: true, min: 1 },
    quantityReceived: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const PurchaseSchema = new Schema<IPurchase>(
  {
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
  },
  { timestamps: true }
);

export const Purchase = mongoose.model<IPurchase>('Purchase', PurchaseSchema);
