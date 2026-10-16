import mongoose, { Schema, Document, Types } from 'mongoose';
import { MOVEMENT_TYPES, MovementType } from '../config/constants.js';

export interface IStockMovement extends Document {
  product: Types.ObjectId;
  serializedItem?: Types.ObjectId;
  location: Types.ObjectId;
  movementType: MovementType;
  quantityDelta: number; // Signed delta (+10, -2, etc.)
  sourceStatus?: string;
  destinationStatus?: string;
  transactionRef: string;
  transactionModel: string;
  reason: string;
  performedBy: Types.ObjectId;
  idempotencyKey?: string;
  createdAt: Date;
}

const StockMovementSchema = new Schema<IStockMovement>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    serializedItem: { type: Schema.Types.ObjectId, ref: 'SerializedItem' },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    movementType: {
      type: String,
      enum: Object.values(MOVEMENT_TYPES),
      required: true,
    },
    quantityDelta: { type: Number, required: true },
    sourceStatus: { type: String },
    destinationStatus: { type: String },
    transactionRef: { type: String, required: true, trim: true },
    transactionModel: { type: String, required: true, trim: true },
    reason: { type: String, required: true, trim: true },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Indexes for ledger queries and audits
StockMovementSchema.index({ product: 1, createdAt: -1 });
StockMovementSchema.index({ serializedItem: 1, createdAt: -1 });
StockMovementSchema.index({ location: 1, createdAt: -1 });
StockMovementSchema.index({ transactionRef: 1 });
StockMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const StockMovement = mongoose.model<IStockMovement>('StockMovement', StockMovementSchema);
