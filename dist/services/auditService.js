import { AuditLog } from '../models/AuditLog.js';
export async function logAudit(params) {
    try {
        await AuditLog.create({
            actor: params.actor.id,
            actorEmail: params.actor.email,
            actorRole: params.actor.role,
            action: params.action,
            entityType: params.entityType,
            entityId: params.entityId,
            beforeState: params.beforeState,
            afterState: params.afterState,
            reason: params.reason,
            ipAddress: params.ipAddress,
        });
    }
    catch (err) {
        console.error('[AUDIT_LOG_ERROR] Failed to persist audit entry:', err);
    }
}
