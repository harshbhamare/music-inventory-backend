import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IReceiptLineItem {
  product: Types.ObjectId;
  quantityReceived: number;
  unitCost: number;
  serializedItemIds?: Types.ObjectId[];
}

export interface IPurchaseReceipt extends Document {
  receiptNumber: string;
  purchase: Types.ObjectId;
  receivedDate: Date;
  lineItems: IReceiptLineItem[];
  destinationLocation: Types.ObjectId;
  receivedBy: Types.ObjectId;
  notes?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

const ReceiptLineItemSchema = new Schema<IReceiptLineItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityReceived: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 },
    serializedItemIds: [{ type: Schema.Types.ObjectId, ref: 'SerializedItem' }],
  },
  { _id: false }
);

const PurchaseReceiptSchema = new Schema<IPurchaseReceipt>(
  {
    receiptNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    purchase: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    receivedDate: { type: Date, default: Date.now },
    lineItems: [ReceiptLineItemSchema],
    destinationLocation: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    notes: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PurchaseReceiptSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
PurchaseReceiptSchema.index({ purchase: 1 });

export const PurchaseReceipt = mongoose.model<IPurchaseReceipt>('PurchaseReceipt', PurchaseReceiptSchema);
