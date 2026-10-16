import mongoose, { Schema } from 'mongoose';
import { ROLES } from '../config/constants.js';
const UserSchema = new Schema({
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
}, { timestamps: true });
export const User = mongoose.model('User', UserSchema);
