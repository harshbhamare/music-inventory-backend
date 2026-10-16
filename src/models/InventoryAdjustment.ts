import mongoose, { Schema, Document, Types } from 'mongoose';
import { ADJUSTMENT_STATUSES, AdjustmentStatus } from '../config/constants.js';

export interface IAdjustmentItem {
  product: Types.ObjectId;
  serializedItem?: Types.ObjectId;
  quantityDelta: number; // Signed delta (e.g. -1 for loss/write-off, +2 for found stock)
  targetStatus?: string; // e.g., 'RETIRED', 'QUARANTINED', 'AVAILABLE'
  reason: string;
}

export interface IInventoryAdjustment extends Document {
  adjustmentReference: string;
  location: Types.ObjectId;
  type: 'WRITE_OFF' | 'MANUAL_COUNT' | 'DAMAGE_LOSS' | 'FOUND_ITEM' | 'CORRECTION';
  items: IAdjustmentItem[];
  reason: string;
  supportingDocumentUrl?: string;
  status: AdjustmentStatus;
  requestedBy: Types.ObjectId;
  requiresApproval: boolean;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  appliedMovementIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const AdjustmentItemSchema = new Schema<IAdjustmentItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    serializedItem: { type: Schema.Types.ObjectId, ref: 'SerializedItem' },
    quantityDelta: { type: Number, required: true },
    targetStatus: { type: String },
    reason: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const InventoryAdjustmentSchema = new Schema<IInventoryAdjustment>(
  {
    adjustmentReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    type: {
      type: String,
      enum: ['WRITE_OFF', 'MANUAL_COUNT', 'DAMAGE_LOSS', 'FOUND_ITEM', 'CORRECTION'],
      default: 'CORRECTION',
      required: true,
    },
    items: [AdjustmentItemSchema],
    reason: { type: String, required: true, trim: true },
    supportingDocumentUrl: { type: String, trim: true },
    status: {
      type: String,
      enum: Object.values(ADJUSTMENT_STATUSES),
      default: ADJUSTMENT_STATUSES.PENDING_APPROVAL,
      required: true,
    },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requiresApproval: { type: Boolean, default: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    appliedMovementIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
  },
  { timestamps: true }
);

InventoryAdjustmentSchema.index({ status: 1 });
InventoryAdjustmentSchema.index({ requestedBy: 1 });

export const InventoryAdjustment = mongoose.model<IInventoryAdjustment>(
  'InventoryAdjustment',
  InventoryAdjustmentSchema
);
