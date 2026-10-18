import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAppSetting extends Document {
  companyName: string;
  storeName?: string;
  storeCode?: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  currency: string;
  currencySymbol: string;
  timeZone: string;
  defaultLocation: Types.ObjectId;
  managerApprovalThresholdValue: number; // e.g. manual adjustments over 5 units or ₹10,000 need approval
  overdueGracePeriodDays: number;
  lowStockAlertThresholdDefault: number;
  updatedAt: Date;
}

const AppSettingSchema = new Schema<IAppSetting>(
  {
    companyName: { type: String, default: 'Stereobliss Retail' },
    storeName: { type: String, default: 'Stereobliss Central Store' },
    storeCode: { type: String, default: 'CENTRAL' },
    contactEmail: { type: String, default: 'contact@stereobliss.com' },
    contactPhone: { type: String, default: '+91 98765 43210' },
    address: { type: String, default: 'Aundh & Hinjawadi, Pune, Maharashtra, India' },
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    timeZone: { type: String, default: 'Asia/Kolkata' },
    defaultLocation: { type: Schema.Types.ObjectId, ref: 'StockLocation' },
    managerApprovalThresholdValue: { type: Number, default: 3 }, // any manual change of > 3 units requires manager approval
    overdueGracePeriodDays: { type: Number, default: 1 },
    lowStockAlertThresholdDefault: { type: Number, default: 5 },
  },
  { timestamps: true }
);

export const AppSetting = mongoose.model<IAppSetting>('AppSetting', AppSettingSchema);
