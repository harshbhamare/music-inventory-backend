import mongoose, { Schema } from 'mongoose';
import { USAGE_PURPOSES, USAGE_STATUSES, ITEM_CONDITIONS, } from '../config/constants.js';
const UsageItemSchema = new Schema({
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
}, { _id: false });
const RentalMonthlyPaymentSchema = new Schema({
    monthIndex: { type: Number, required: true },
    billingMonth: { type: String, required: true },
    dueDate: { type: Date, required: true },
    amountDue: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    paidAt: { type: Date },
    paymentMethod: { type: String },
    transactionRef: { type: String, trim: true },
    status: { type: String, enum: ['PAID', 'DUE', 'OVERDUE'], default: 'DUE' },
    notes: { type: String, trim: true },
}, { _id: true });
const RentalReminderSchema = new Schema({
    sentAt: { type: Date, default: Date.now },
    sentTo: { type: String, required: true },
    channel: { type: String, enum: ['EMAIL', 'SMS', 'WHATSAPP'], default: 'EMAIL' },
    message: { type: String, required: true },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { _id: true });
const RentalPaymentLogSchema = new Schema({
    paymentType: {
        type: String,
        enum: ['SECURITY_DEPOSIT', 'RENTAL_PAYMENT'],
        required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, required: true },
    transactionRef: { type: String, required: true, trim: true },
    billingMonth: { type: String, trim: true },
    notes: { type: String, trim: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    paidAt: { type: Date, default: Date.now },
}, { _id: true, timestamps: true });
const InternalUsageSchema = new Schema({
    issueReference: { type: String, required: true, unique: true, uppercase: true, trim: true },
    purpose: {
        type: String,
        enum: Object.values(USAGE_PURPOSES),
        required: true,
    },
    customPurposeDetail: { type: String, trim: true },
    assignedPerson: { type: String, required: true, trim: true },
    assignedPersonContact: { type: String, trim: true },
    customerEmail: { type: String, lowercase: true, trim: true },
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
    isRental: { type: Boolean, default: true },
    lockInPeriodMonths: { type: Number, default: 3, min: 1 },
    securityDeposit: { type: Number, default: 0, min: 0 },
    monthlyRent: { type: Number, default: 0, min: 0 },
    includedAccessories: [{ type: String, trim: true }],
    monthlyPayments: [RentalMonthlyPaymentSchema],
    totalRentPaid: { type: Number, default: 0, min: 0 },
    totalRentDue: { type: Number, default: 0, min: 0 },
    remindersSent: [RentalReminderSchema],
    paymentLogs: [RentalPaymentLogSchema],
    extensions: [
        {
            extendedDate: { type: Date, required: true },
            reason: { type: String, required: true },
            approvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
            createdAt: { type: Date, default: Date.now },
        },
    ],
}, { timestamps: true });
InternalUsageSchema.index({ status: 1, expectedReturnDate: 1 });
InternalUsageSchema.index({ assignedPerson: 'text' });
export const InternalUsage = mongoose.model('InternalUsage', InternalUsageSchema);
