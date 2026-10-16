import { ROLES } from '../config/constants.js';
export function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
            });
            return;
        }
        const currentRole = req.user.role === 'INVENTORY_MANAGER' ? ROLES.MANAGER : req.user.role;
        const hasPermission = allowedRoles.includes(currentRole) ||
            allowedRoles.includes(req.user.role) ||
            (allowedRoles.includes(ROLES.MANAGER) && req.user.role === 'INVENTORY_MANAGER');
        if (!hasPermission) {
            res.status(403).json({
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: `Access denied. Requires one of roles: [${allowedRoles.join(', ')}].`,
                },
            });
            return;
        }
        next();
    };
}
export function isManagerOrAdmin(role) {
    return role === ROLES.SUPER_ADMIN || role === ROLES.MANAGER || role === 'INVENTORY_MANAGER';
}
