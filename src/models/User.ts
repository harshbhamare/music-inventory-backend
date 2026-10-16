import mongoose, { Schema, Document } from 'mongoose';
import { ROLES, UserRole } from '../config/constants.js';

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'MANAGER', 'INVENTORY_MANAGER'],
      default: ROLES.MANAGER,
      required: true,
    },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', UserSchema);
