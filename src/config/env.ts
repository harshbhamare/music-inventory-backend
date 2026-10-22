import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET || 'stereobliss-super-secret-production-key-2026',
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || 'stereobliss_session',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'sales@stereobliss.com',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: process.env.SMTP_SECURE !== 'false',
  SMTP_USER: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER || '',
  SMTP_PASS: (process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD || process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  ALERT_EMAIL: process.env.ALERT_EMAIL || process.env.GMAIL_USER || '',
  DEFAULT_LOCATION_CODE: 'PUNE_HQ',
  DEFAULT_LOCATION_NAME: 'Stereobliss Central Store',
};
