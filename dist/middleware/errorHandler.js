export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(message, statusCode = 400, code = 'BAD_REQUEST', details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export function errorHandler(err, req, res, _next) {
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
            details: err.details || (err.errors ? Object.values(err.errors).map((e) => e.message) : undefined),
        },
    });
}
