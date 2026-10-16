import mongoose, { Schema } from 'mongoose';
import { REPORT_TYPES } from '../config/constants.js';
const EmailDeliveryLogSchema = new Schema({
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
}, { timestamps: { createdAt: true, updatedAt: false } });
EmailDeliveryLogSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
EmailDeliveryLogSchema.index({ createdAt: -1 });
export const EmailDeliveryLog = mongoose.model('EmailDeliveryLog', EmailDeliveryLogSchema);
