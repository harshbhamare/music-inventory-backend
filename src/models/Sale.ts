import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  SALE_STATUSES,
  SaleStatus,
  PAYMENT_STATUSES,
  PaymentStatus,
  PAYMENT_METHODS,
  PaymentMethod,
} from '../config/constants.js';

export interface ISaleLineItem {
  product: Types.ObjectId;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
  serializedItemIds?: Types.ObjectId[];
}

export interface ISale extends Document {
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  location: Types.ObjectId;
  lineItems: ISaleLineItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  saleStatus: SaleStatus;
  notes?: string;
  soldBy: Types.ObjectId;
  confirmedAt?: Date;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SaleLineItemSchema = new Schema<ISaleLineItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    serializedItemIds: [{ type: Schema.Types.ObjectId, ref: 'SerializedItem' }],
  },
  { _id: false }
);

const SaleSchema = new Schema<ISale>(
  {
    invoiceNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, lowercase: true, trim: true },
    customerPhone: { type: String, trim: true },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    lineItems: [SaleLineItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUSES),
      default: PAYMENT_STATUSES.PAID,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      default: PAYMENT_METHODS.UPI,
      required: true,
    },
    saleStatus: {
      type: String,
      enum: Object.values(SALE_STATUSES),
      default: SALE_STATUSES.CONFIRMED,
      required: true,
    },
    notes: { type: String, trim: true },
    soldBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedAt: { type: Date, default: Date.now },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: true }
);

SaleSchema.index({ customerName: 'text', customerPhone: 'text' });
SaleSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
SaleSchema.index({ createdAt: -1 });

export const Sale = mongoose.model<ISale>('Sale', SaleSchema);
