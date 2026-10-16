import mongoose, { Schema } from 'mongoose';
const AuditLogSchema = new Schema({
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorEmail: { type: String, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true, trim: true },
    entityType: { type: String, required: true, trim: true },
    entityId: { type: String, required: true, trim: true },
    beforeState: { type: Schema.Types.Mixed },
    afterState: { type: Schema.Types.Mixed },
    reason: { type: String, trim: true },
    ipAddress: { type: String, trim: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
AuditLogSchema.index({ entityType: 1, entityId: 1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 });
export const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
