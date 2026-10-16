import mongoose, { Schema, Document } from 'mongoose';
import { REPORT_TYPES, ReportType } from '../config/constants.js';

export interface IEmailDeliveryLog extends Document {
  reportType: ReportType;
  recipients: string[];
  subject: string;
  bodySnippet?: string;
  status: 'SENT' | 'FAILED' | 'SIMULATED';
  deliveryAttempt: number;
  providerReference?: string;
  errorDetails?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

const EmailDeliveryLogSchema = new Schema<IEmailDeliveryLog>(
  {
    reportType: {
      type: String,
      enum: Object.values(REPORT_TYPES),
      required: true,
    },
    recipients: [{ type: String, required: true }],
    subject: { type: String, required: true },
    bodySnippet: { type: String },
    status: {
      type: String,
      enum: ['SENT', 'FAILED', 'SIMULATED'],
      required: true,
    },
    deliveryAttempt: { type: Number, default: 1 },
    providerReference: { type: String },
    errorDetails: { type: String },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmailDeliveryLogSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
EmailDeliveryLogSchema.index({ createdAt: -1 });

export const EmailDeliveryLog = mongoose.model<IEmailDeliveryLog>(
  'EmailDeliveryLog',
  EmailDeliveryLogSchema
);
