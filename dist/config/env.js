import dotenv from 'dotenv';
dotenv.config();
export const ENV = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT || '5000', 10),
    MONGODB_URI: process.env.MONGODB_URI || '',
    JWT_SECRET: process.env.JWT_SECRET || 'soundstock-super-secret-production-key-2026',
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || 'soundstock_session',
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    EMAIL_FROM: process.env.EMAIL_FROM || 'inventory@soundstock.io',
    DEFAULT_LOCATION_CODE: 'PUNE_HQ',
    DEFAULT_LOCATION_NAME: 'Central Studio Academy & Store',
};
