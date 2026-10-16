import mongoose, { Schema } from 'mongoose';
const AppSettingSchema = new Schema({
    companyName: { type: String, default: 'SoundStock Studio Academy & Store' },
    contactEmail: { type: String, default: 'contact@soundstock.io' },
    contactPhone: { type: String, default: '+91 98765 43210' },
    address: { type: String, default: 'Aundh & Hinjawadi, Pune, Maharashtra, India' },
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    timeZone: { type: String, default: 'Asia/Kolkata' },
    defaultLocation: { type: Schema.Types.ObjectId, ref: 'StockLocation' },
    managerApprovalThresholdValue: { type: Number, default: 3 }, // any manual change of > 3 units requires manager approval
    overdueGracePeriodDays: { type: Number, default: 1 },
    lowStockAlertThresholdDefault: { type: Number, default: 5 },
}, { timestamps: true });
export const AppSetting = mongoose.model('AppSetting', AppSettingSchema);
