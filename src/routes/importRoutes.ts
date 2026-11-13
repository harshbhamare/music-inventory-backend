/**
 * Historical Data Import Routes
 * Endpoints for Super Admin and Managers to import historical inventory and sales data.
 *
 * GET  /import/template   → Download Excel template (.xlsx)
 * POST /import/validate   → Validate uploaded file, return row errors + preview
 * POST /import/execute    → Execute the import, return ImportResult
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES } from '../config/constants.js';
import {
  generateImportTemplate,
  validateImportFile,
  executeImport,
} from '../services/importService.js';

const router = Router();

// Multer memory storage (50 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

/**
 * Custom upload middleware wrapper:
 * - Catches multer errors gracefully (file size, format) and returns clean HTTP 400
 * - Performs case-insensitive extension and mimetype check
 */
function handleUpload(fieldName: string) {
  const multerSingle = upload.single(fieldName);
  return (req: Request, res: Response, next: NextFunction) => {
    multerSingle(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: {
              code: 'FILE_TOO_LARGE',
              message: 'The uploaded file exceeds the 50 MB size limit.',
            },
          });
        }
        return res.status(400).json({
          success: false,
          error: {
            code: 'UPLOAD_ERROR',
            message: err.message || 'File upload failed.',
          },
        });
      }

      if (req.file) {
        const originalName = (req.file.originalname || '').toLowerCase();
        const isValidExtension =
          originalName.endsWith('.xlsx') ||
          originalName.endsWith('.xls') ||
          originalName.endsWith('.csv');

        const isValidMime =
          req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          req.file.mimetype === 'application/vnd.ms-excel' ||
          req.file.mimetype === 'text/csv' ||
          req.file.mimetype === 'application/octet-stream' ||
          req.file.mimetype === 'application/x-zip-compressed' ||
          req.file.mimetype === 'application/zip';

        if (!isValidExtension && !isValidMime) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_FILE_TYPE',
              message: 'Only Excel spreadsheet files (.xlsx, .xls) are accepted.',
            },
          });
        }
      }

      next();
    });
  };
}

// ── GET /import/template ──────────────────────────────────────────────────────
router.get(
  '/template',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const buf = generateImportTemplate();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="muziclub-inventory-import-template.xlsx"'
      );
      res.setHeader('Content-Length', buf.length);
      res.send(buf);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /import/validate ─────────────────────────────────────────────────────
router.post(
  '/validate',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  handleUpload('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded. Please attach your Excel file in the "file" field.',
          },
        });
      }

      let result;
      try {
        result = await validateImportFile(req.file.buffer);
      } catch (parseErr: any) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'CORRUPTED_FILE',
            message: `Could not parse Excel spreadsheet: ${parseErr.message || 'Invalid or password-protected file.'}`,
          },
        });
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /import/execute ──────────────────────────────────────────────────────
router.post(
  '/execute',
  requireAuth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER),
  handleUpload('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded. Please attach your Excel file in the "file" field.',
          },
        });
      }

      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authenticated user session is required to execute an import.',
          },
        });
      }

      // Check forceImport parameter from either body, query string, or FormData text field
      const force =
        req.body?.forceImport === 'true' ||
        req.body?.forceImport === true ||
        req.query?.forceImport === 'true' ||
        req.query?.force === 'true' ||
        // FormData text fields parsed by multer appear in req.body too — belt-and-suspenders
        String(req.body?.forceImport ?? '').toLowerCase() === 'true';

      if (!force) {
        let validation;
        try {
          validation = await validateImportFile(req.file.buffer);
        } catch (parseErr: any) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'CORRUPTED_FILE',
              message: `Could not parse Excel spreadsheet: ${parseErr.message || 'Invalid file format.'}`,
            },
          });
        }

        if (!validation.valid) {
          return res.status(422).json({
            success: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: `Import aborted: ${validation.errorCount} validation error(s) found. Fix the highlighted errors or check "Skip invalid rows" to proceed with valid data.`,
            },
            data: { validation },
          });
        }
      }

      const result = await executeImport(req.file.buffer, req.user);

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
