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

export interface IRentalMonthlyPayment {
  _id?: Types.ObjectId;
  monthIndex: number;
  billingMonth: string;
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
  paidAt?: Date;
  paymentMethod?: string;
  transactionRef?: string;
  status: 'PAID' | 'DUE' | 'OVERDUE';
  notes?: string;
}

export interface IRentalReminder {
  sentAt: Date;
  sentTo: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  message: string;
  sentBy: Types.ObjectId;
}

export interface IInternalUsage extends Document {
  issueReference: string;
  purpose: UsagePurpose;
  customPurposeDetail?: string;
  assignedPerson: string; // Renter / Student / Customer
  assignedPersonContact?: string;
  customerEmail?: string;
  location: Types.ObjectId;
  items: IUsageItem[];
  issueDate: Date;
  expectedReturnDate: Date;
  actualReturnDate?: Date;
  status: UsageStatus;
  notes?: string;
  issuedBy: Types.ObjectId;
  isRental: boolean;
  lockInPeriodMonths: number;
  securityDeposit: number;
  monthlyRent: number;
  includedAccessories: string[];
  monthlyPayments: IRentalMonthlyPayment[];
  totalRentPaid: number;
  totalRentDue: number;
  remindersSent: IRentalReminder[];
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

const RentalMonthlyPaymentSchema = new Schema<IRentalMonthlyPayment>(
  {
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
  },
  { _id: true }
);

const RentalReminderSchema = new Schema<IRentalReminder>(
  {
    sentAt: { type: Date, default: Date.now },
    sentTo: { type: String, required: true },
    channel: { type: String, enum: ['EMAIL', 'SMS', 'WHATSAPP'], default: 'EMAIL' },
    message: { type: String, required: true },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: true }
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
