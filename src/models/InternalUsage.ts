import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  USAGE_PURPOSES,
  UsagePurpose,
  USAGE_STATUSES,
  UsageStatus,
  ITEM_CONDITIONS,
  ItemCondition,
} from '../config/constants.js';

export interface IUsageItem {
  product: Types.ObjectId;
  quantityIssued: number;
  quantityReturned: number;
  serializedItemId?: Types.ObjectId;
  issueCondition: ItemCondition;
}

export interface IInternalUsage extends Document {
  issueReference: string;
  purpose: UsagePurpose;
  customPurposeDetail?: string;
  assignedPerson: string; // student, teacher, or band member responsible
  assignedPersonContact?: string;
  location: Types.ObjectId;
  items: IUsageItem[];
  issueDate: Date;
  expectedReturnDate: Date;
  actualReturnDate?: Date;
  status: UsageStatus;
  notes?: string;
  issuedBy: Types.ObjectId;
  extensions: Array<{
    extendedDate: Date;
    reason: string;
    approvedBy: Types.ObjectId;
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const UsageItemSchema = new Schema<IUsageItem>(
  {
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
  },
  { _id: false }
);

const InternalUsageSchema = new Schema<IInternalUsage>(
  {
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
  },
  { timestamps: true }
);

InternalUsageSchema.index({ status: 1, expectedReturnDate: 1 });
InternalUsageSchema.index({ assignedPerson: 'text' });

export const InternalUsage = mongoose.model<IInternalUsage>('InternalUsage', InternalUsageSchema);
