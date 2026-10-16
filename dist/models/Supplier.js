import mongoose, { Schema } from 'mongoose';
const SupplierSchema = new Schema({
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });
export const Supplier = mongoose.model('Supplier', SupplierSchema);
