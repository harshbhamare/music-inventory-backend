import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import { ENV } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import productRoutes from './routes/productRoutes.js';
import intakeRoutes from './routes/intakeRoutes.js';
import salesRoutes from './routes/salesRoutes.js';
import usageRoutes from './routes/usageRoutes.js';
import maintenanceRoutes from './routes/maintenanceRoutes.js';
import adjustmentRoutes from './routes/adjustmentRoutes.js';
import movementRoutes from './routes/movementRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import metaRoutes from './routes/metaRoutes.js';
export function createApp() {
    const app = express();
    // Security & utilities
    const helmetFn = typeof helmet === 'function' ? helmet : helmet.default;
    if (typeof helmetFn === 'function') {
        app.use(helmetFn({
            contentSecurityPolicy: false, // Let frontend frame API if needed
            crossOriginResourcePolicy: { policy: 'cross-origin' },
        }));
    }
    app.use(cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps, server-to-server, curl)
            if (!origin)
                return callback(null, true);
            // Allow localhost, custom frontend URL, and any Vercel deployment (*.vercel.app)
            if (origin === 'http://localhost:3000' ||
                origin === ENV.FRONTEND_URL ||
                origin.endsWith('.vercel.app') ||
                ENV.NODE_ENV !== 'production') {
                return callback(null, true);
            }
            return callback(null, true);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    }));
    app.use(cookieParser());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    if (ENV.NODE_ENV !== 'test') {
        app.use(morgan('dev'));
    }
    // Health check endpoints
    app.get(['/', '/api', '/health', '/api/health'], (_req, res) => {
        res.json({
            status: 'healthy',
            app: 'StereoBliss - Retail Inventory Backend API',
            timestamp: new Date().toISOString(),
            environment: ENV.NODE_ENV,
        });
    });
    // Versioned API v1 routes (mounted at /api/v1 and /v1 for routing flexibility)
    const v1 = express.Router();
    v1.use('/auth', authRoutes);
    v1.use('/products', productRoutes);
    v1.use('/intake', intakeRoutes);
    v1.use('/sales', salesRoutes);
    v1.use('/usage', usageRoutes);
    v1.use('/maintenance', maintenanceRoutes);
    v1.use('/adjustments', adjustmentRoutes);
    v1.use('/movements', movementRoutes);
    v1.use('/reports', reportRoutes);
    v1.use('/meta', metaRoutes);
    app.use('/api/v1', v1);
    app.use('/v1', v1);
    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            success: false,
            error: {
                code: 'NOT_FOUND',
                message: `Endpoint ${req.method} ${req.originalUrl} does not exist.`,
            },
        });
    });
    // Global centralized error handler
    app.use(errorHandler);
    return app;
}
