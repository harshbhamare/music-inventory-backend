import mongoose, { Schema, Document } from 'mongoose';

export interface IStockLocation extends Document {
  name: string;
  code: string;
  type: string;
  address?: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const StockLocationSchema = new Schema<IStockLocation>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, default: 'STORE' },
    address: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const StockLocation = mongoose.model<IStockLocation>('StockLocation', StockLocationSchema);
