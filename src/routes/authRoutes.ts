import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { ENV } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, createUserSchema } from '../validators/index.js';
import { ROLES } from '../config/constants.js';
import { AppError } from '../middleware/errorHandler.js';
import { logAudit } from '../services/auditService.js';

const router = Router();

router.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body;
      const normalizedEmail = email.toLowerCase().trim();
      let user = await User.findOne({ email: normalizedEmail });

      if (!user) {
        throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      if (!user.isActive) {
        throw new AppError('User account is deactivated. Please contact an administrator.', 403, 'ACCOUNT_DEACTIVATED');
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      user.lastLogin = new Date();
      await user.save();

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        ENV.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.cookie(ENV.SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: ENV.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.json({
        success: true,
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
          token,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie(ENV.SESSION_COOKIE_NAME);
  res.json({ success: true, message: 'Logged out successfully.' });
});

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.user!.id).select('-passwordHash').lean();
    res.json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/users',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.INVENTORY_MANAGER),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await User.find().select('-passwordHash').sort({ createdAt: -1 }).lean();
      res.json({ success: true, data: { users } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/users',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  validate(createUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, password, role } = req.body;
      const existing = await User.findOne({ email: email.toLowerCase().trim() });
      if (existing) {
        throw new AppError('A user with this email already exists.', 409, 'DUPLICATE_EMAIL');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role,
        isActive: true,
      });

      await logAudit({
        actor: req.user!,
        action: 'CREATE_USER',
        entityType: 'User',
        entityId: user._id.toString(),
        afterState: { name: user.name, email: user.email, role: user.role },
        reason: 'Created new staff user',
      });

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isActive: user.isActive,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/users/:id/status',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) throw new AppError('User not found.', 404);

      if (user._id.toString() === req.user!.id) {
        throw new AppError('You cannot deactivate your own account.', 400, 'SELF_DEACTIVATION');
      }

      user.isActive = !user.isActive;
      await user.save();

      await logAudit({
        actor: req.user!,
        action: 'TOGGLE_USER_STATUS',
        entityType: 'User',
        entityId: user._id.toString(),
        afterState: { isActive: user.isActive },
        reason: user.isActive ? 'Re-activated user' : 'Deactivated user',
      });

      res.json({ success: true, data: { user: { id: user._id, isActive: user.isActive } } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
