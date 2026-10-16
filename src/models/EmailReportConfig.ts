import mongoose, { Schema, Document } from 'mongoose';
import { REPORT_TYPES, ReportType } from '../config/constants.js';

export interface IEmailReportConfig extends Document {
  reportType: ReportType;
  title: string;
  recipients: string[];
  scheduleCron: string;
  timeZone: string;
  isEnabled: boolean;
  lastRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailReportConfigSchema = new Schema<IEmailReportConfig>(
  {
    reportType: {
      type: String,
      enum: Object.values(REPORT_TYPES),
      required: true,
      unique: true,
    },
    title: { type: String, required: true },
    recipients: [{ type: String, trim: true, lowercase: true }],
    scheduleCron: { type: String, required: true, default: '0 9 * * *' }, // 9 AM daily by default
    timeZone: { type: String, default: 'Asia/Kolkata' },
    isEnabled: { type: Boolean, default: true },
    lastRunAt: { type: Date },
  },
  { timestamps: true }
);

export const EmailReportConfig = mongoose.model<IEmailReportConfig>(
  'EmailReportConfig',
  EmailReportConfigSchema
);
