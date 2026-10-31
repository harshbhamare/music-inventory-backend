/**
 * Historical Data Import Routes
 * All endpoints are restricted to SUPER_ADMIN only.
 *
 * GET  /import/template   → Download Excel template (.xlsx)
 * POST /import/validate   → Validate uploaded file, return row errors + preview
 * POST /import/execute    → Execute the import, return ImportResult
 */
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { ROLES } from '../config/constants.js';
import { generateImportTemplate, validateImportFile, executeImport, } from '../services/importService.js';
const router = Router();
// Multer: store file in memory (max 50 MB for large historical datasets)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    fileFilter: (_req, file, cb) => {
        const ok = file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            file.mimetype === 'application/vnd.ms-excel' ||
            file.originalname.endsWith('.xlsx') ||
            file.originalname.endsWith('.xls');
        if (!ok) {
            return cb(new Error('Only Excel files (.xlsx) are accepted.'));
        }
        cb(null, true);
    },
});
// ── GET /import/template ──────────────────────────────────────────────────────
router.get('/template', requireAuth, requireRole(ROLES.SUPER_ADMIN), (_req, res, next) => {
    try {
        const buf = generateImportTemplate();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="stereobliss-historical-import-template.xlsx"');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
    }
    catch (err) {
        next(err);
    }
});
// ── POST /import/validate ─────────────────────────────────────────────────────
router.post('/validate', requireAuth, requireRole(ROLES.SUPER_ADMIN), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: { message: 'No file uploaded. Attach the Excel file as the "file" field.' },
            });
        }
        const result = await validateImportFile(req.file.buffer);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
// ── POST /import/execute ──────────────────────────────────────────────────────
router.post('/execute', requireAuth, requireRole(ROLES.SUPER_ADMIN), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: { message: 'No file uploaded. Attach the Excel file as the "file" field.' },
            });
        }
        // Run validation first — abort if hard errors exist (unless forceImport=true is passed)
        const force = req.body?.forceImport === 'true' || req.body?.forceImport === true;
        if (!force) {
            const validation = await validateImportFile(req.file.buffer);
            if (!validation.valid) {
                return res.status(422).json({
                    success: false,
                    error: {
                        message: `Import aborted: ${validation.errorCount} validation error(s) found. Fix them or send forceImport=true to skip invalid rows.`,
                    },
                    data: { validation },
                });
            }
        }
        const result = await executeImport(req.file.buffer, req.user);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
