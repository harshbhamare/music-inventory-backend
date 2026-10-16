import mongoose, { Schema } from 'mongoose';
const StockLocationSchema = new Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, default: 'STORE' },
    address: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });
export const StockLocation = mongoose.model('StockLocation', StockLocationSchema);
