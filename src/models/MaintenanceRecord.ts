import mongoose, { Schema, Document, Types } from 'mongoose';
import { MAINTENANCE_STATUSES, MaintenanceStatus } from '../config/constants.js';

export interface IMaintenanceRecord extends Document {
  recordReference: string;
  product: Types.ObjectId;
  serializedItem?: Types.ObjectId;
  location: Types.ObjectId;
  problemDescription: string;
  repairDetails?: string;
  vendor?: string;
  cost: number;
  status: MaintenanceStatus;
  startedAt: Date;
  completedAt?: Date;
  createdByUser: Types.ObjectId;
  releasedByUser?: Types.ObjectId;
  releaseDisposition?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MaintenanceRecordSchema = new Schema<IMaintenanceRecord>(
  {
    recordReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    serializedItem: { type: Schema.Types.ObjectId, ref: 'SerializedItem' },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    problemDescription: { type: String, required: true, trim: true },
    repairDetails: { type: String, trim: true },
    vendor: { type: String, trim: true },
    cost: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: Object.values(MAINTENANCE_STATUSES),
      default: MAINTENANCE_STATUSES.IN_PROGRESS,
      required: true,
    },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    createdByUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    releasedByUser: { type: Schema.Types.ObjectId, ref: 'User' },
    releaseDisposition: { type: String },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

MaintenanceRecordSchema.index({ serializedItem: 1, status: 1 });
MaintenanceRecordSchema.index({ status: 1 });

export const MaintenanceRecord = mongoose.model<IMaintenanceRecord>(
  'MaintenanceRecord',
  MaintenanceRecordSchema
);
