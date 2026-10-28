import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  SALE_STATUSES,
  SaleStatus,
  PAYMENT_STATUSES,
  PaymentStatus,
  PAYMENT_METHODS,
  PaymentMethod,
  SALE_TYPES,
  SaleType,
} from '../config/constants.js';

export interface ISaleLineItem {
  product: Types.ObjectId;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
  hsnCode?: string;
  taxableAmount?: number;
  cgstAmount?: number;
  sgstAmount?: number;
  serializedItemIds?: Types.ObjectId[];
}

export interface IEmiMonthlyPayment {
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

export interface IEmiReminder {
  sentAt: Date;
  sentTo: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  message: string;
  sentBy: Types.ObjectId;
}

export interface ISale extends Document {
  invoiceNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerGstin?: string;
  customerAddress?: string;
  eWayBillNo?: string;
  dispatchThrough?: string;
  destination?: string;
  irn?: string;
  ackNo?: string;
  ackDate?: Date;
  location: Types.ObjectId;
  lineItems: ISaleLineItem[];
  subtotal: number;
  discountTotal: number;
  taxableAmount: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  taxTotal: number;
  grandTotal: number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  saleStatus: SaleStatus;
  saleType: SaleType;
  isEmi: boolean;
  downPayment: number;
  emiTenureMonths: number;
  monthlyEmiAmount: number;
  totalEmiPaid: number;
  totalEmiDue: number;
  emiPayments: IEmiMonthlyPayment[];
  remindersSent: IEmiReminder[];
  notes?: string;
  remarks?: string;
  soldBy: Types.ObjectId;
  confirmedAt?: Date;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SaleLineItemSchema = new Schema<ISaleLineItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxableAmount: { type: Number, default: 0, min: 0 },
    hsnCode: { type: String, default: '9202', trim: true },
    cgstAmount: { type: Number, default: 0, min: 0 },
    sgstAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    serializedItemIds: [{ type: Schema.Types.ObjectId, ref: 'SerializedItem' }],
  },
  { _id: false }
);

const EmiMonthlyPaymentSchema = new Schema<IEmiMonthlyPayment>(
  {
    monthIndex: { type: Number, required: true },
    billingMonth: { type: String, required: true },
    dueDate: { type: Date, required: true },
    amountDue: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    paidAt: { type: Date },
    paymentMethod: { type: String },
    transactionRef: { type: String, trim: true },
    status: {
      type: String,
      enum: ['PAID', 'DUE', 'OVERDUE'],
      default: 'DUE',
      required: true,
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

const EmiReminderSchema = new Schema<IEmiReminder>(
  {
    sentAt: { type: Date, default: Date.now },
    sentTo: { type: String, required: true },
    channel: { type: String, enum: ['EMAIL', 'SMS', 'WHATSAPP'], default: 'EMAIL' },
    message: { type: String, required: true },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false }
);

const SaleSchema = new Schema<ISale>(
  {
    invoiceNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, lowercase: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    customerGstin: { type: String, uppercase: true, trim: true },
    customerAddress: { type: String, trim: true },
    eWayBillNo: { type: String, trim: true },
    dispatchThrough: { type: String, trim: true },
    destination: { type: String, trim: true },
    irn: { type: String, trim: true },
    ackNo: { type: String, trim: true },
    ackDate: { type: Date },
    location: { type: Schema.Types.ObjectId, ref: 'StockLocation', required: true },
    lineItems: [SaleLineItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, default: 0, min: 0 },
    taxableAmount: { type: Number, default: 0, min: 0 },
    cgstRate: { type: Number, default: 9, min: 0 },
    cgstAmount: { type: Number, default: 0, min: 0 },
    sgstRate: { type: Number, default: 9, min: 0 },
    sgstAmount: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUSES),
      default: PAYMENT_STATUSES.PAID,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      default: PAYMENT_METHODS.UPI,
      required: true,
    },
    saleStatus: {
      type: String,
      enum: Object.values(SALE_STATUSES),
      default: SALE_STATUSES.CONFIRMED,
      required: true,
    },
    saleType: {
      type: String,
      enum: Object.values(SALE_TYPES),
      default: SALE_TYPES.DIRECT,
      required: true,
    },
    isEmi: { type: Boolean, default: false },
    downPayment: { type: Number, default: 0, min: 0 },
    emiTenureMonths: { type: Number, default: 0, min: 0 },
    monthlyEmiAmount: { type: Number, default: 0, min: 0 },
    totalEmiPaid: { type: Number, default: 0, min: 0 },
    totalEmiDue: { type: Number, default: 0, min: 0 },
    emiPayments: [EmiMonthlyPaymentSchema],
    remindersSent: [EmiReminderSchema],
    notes: { type: String, trim: true },
    remarks: { type: String, trim: true },
    soldBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedAt: { type: Date, default: Date.now },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: true }
);

SaleSchema.index({ customerName: 'text', customerPhone: 'text' });
SaleSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
SaleSchema.index({ createdAt: -1 });

export const Sale = mongoose.model<ISale>('Sale', SaleSchema);
