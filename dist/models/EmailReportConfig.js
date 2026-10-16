import mongoose, { Schema } from 'mongoose';
import { REPORT_TYPES } from '../config/constants.js';
const EmailReportConfigSchema = new Schema({
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
}, { timestamps: true });
export const EmailReportConfig = mongoose.model('EmailReportConfig', EmailReportConfigSchema);
