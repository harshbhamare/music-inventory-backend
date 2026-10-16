import { Request, Response, NextFunction } from 'express';
import { ENV } from '../config/env.js';

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: any;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || (err.name === 'ValidationError' ? 400 : 500);
  const code = err.code || 'INTERNAL_SERVER_ERROR';
  const message = err.message || 'An unexpected error occurred.';

  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, {
    message: err.message,
    stack: err.stack,
    name: err.name,
    code: err.code,
    details: err.details,
  });

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details: err.details || (err.errors ? Object.values(err.errors).map((e: any) => e.message) : undefined),
    },
  });
}
