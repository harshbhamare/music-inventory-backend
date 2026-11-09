import nodemailer from 'nodemailer';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { Sale } from '../models/Sale.js';
import { AppSetting } from '../models/AppSetting.js';
import { REPORT_TYPES, USAGE_STATUSES, } from '../config/constants.js';
import { ENV } from '../config/env.js';
import { generateTaxInvoicePdf, formatIndianCurrency } from './pdfService.js';
import { getRentalProfitabilityReport } from './reportService.js';
let cachedTransporter = null;
export function resetEmailTransporter() {
    cachedTransporter = null;
}
export function getEmailTransporter() {
    if (cachedTransporter) {
        return cachedTransporter;
    }
    const gmailUser = (process.env.GMAIL_USER || ENV.SMTP_USER || '').trim();
    const rawPass = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS || ENV.SMTP_PASS || '';
    const gmailPass = rawPass.replace(/\s+/g, '').trim();
    // 1. Direct Gmail SMTP via SSL on port 465
    if (gmailUser && gmailPass) {
        try {
            cachedTransporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: {
                    user: gmailUser,
                    pass: gmailPass,
                },
                connectionTimeout: 15000,
                greetingTimeout: 15000,
                socketTimeout: 20000,
            });
            console.log(`[EMAIL_INIT] Configured Nodemailer Gmail SSL transporter (smtp.gmail.com:465) for ${gmailUser}`);
            return cachedTransporter;
        }
        catch (err) {
            console.error('[EMAIL_INIT_ERROR] Failed to initialize Gmail SSL transporter:', err);
        }
    }
    // 2. Custom SMTP host & user credentials
    if (ENV.SMTP_HOST && ENV.SMTP_USER) {
        try {
            cachedTransporter = nodemailer.createTransport({
                host: ENV.SMTP_HOST,
                port: ENV.SMTP_PORT,
                secure: ENV.SMTP_SECURE,
                auth: {
                    user: ENV.SMTP_USER,
                    pass: (ENV.SMTP_PASS || '').replace(/\s+/g, '').trim(),
                },
                connectionTimeout: 15000,
                greetingTimeout: 15000,
            });
            console.log(`[EMAIL_INIT] Configured Nodemailer custom SMTP transporter (${ENV.SMTP_HOST}:${ENV.SMTP_PORT})`);
            return cachedTransporter;
        }
        catch (err) {
            console.error('[EMAIL_INIT_ERROR] Failed to initialize SMTP transporter:', err);
        }
    }
    return null;
}
const resendState = {
    dateKey: '',
    countToday: 0,
    quotaExhausted: false,
    initialized: false,
};
function getTodayDateKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}
export async function resetResendDailyQuota() {
    resendState.dateKey = getTodayDateKey();
    resendState.countToday = 0;
    resendState.quotaExhausted = false;
    resendState.lastExhaustedReason = undefined;
    resendState.lastFailoverAt = undefined;
    resendState.initialized = true;
    console.log('[RESEND_QUOTA] Resend daily quota tracker manually reset.');
}
async function ensureResendStateInitialized() {
    const todayKey = getTodayDateKey();
    if (resendState.dateKey !== todayKey || !resendState.initialized) {
        resendState.dateKey = todayKey;
        resendState.quotaExhausted = false;
        resendState.lastExhaustedReason = undefined;
        try {
            const startOfDay = new Date();
            startOfDay.setUTCHours(0, 0, 0, 0);
            const dbCount = await EmailDeliveryLog.countDocuments({
                provider: 'RESEND',
                status: 'SENT',
                createdAt: { $gte: startOfDay },
            });
            resendState.countToday = dbCount;
            const dailyQuota = ENV.RESEND_DAILY_QUOTA || 100;
            if (resendState.countToday >= dailyQuota) {
                resendState.quotaExhausted = true;
                resendState.lastExhaustedReason = `Daily limit reached (${resendState.countToday}/${dailyQuota} emails sent today)`;
            }
        }
        catch {
            resendState.countToday = 0;
        }
        resendState.initialized = true;
    }
}
export async function getEmailEngineStatus() {
    await ensureResendStateInitialized();
    const apiKey = (process.env.RESEND_API_KEY || ENV.RESEND_API_KEY || '').trim();
    const resendConfigured = Boolean(apiKey && apiKey.startsWith('re_'));
    const transporter = getEmailTransporter();
    const nodemailerConfigured = Boolean(transporter);
    const dailyQuota = ENV.RESEND_DAILY_QUOTA || 100;
    let activeEngine;
    if (resendConfigured && !resendState.quotaExhausted && resendState.countToday < dailyQuota) {
        activeEngine = 'RESEND';
    }
    else if (nodemailerConfigured) {
        activeEngine = 'NODEMAILER';
    }
    else {
        activeEngine = 'SIMULATED';
    }
    return {
        activeEngine,
        resend: {
            configured: resendConfigured,
            apiKeyMasked: resendConfigured ? `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}` : null,
            dailyQuota,
            usedToday: resendState.countToday,
            remainingToday: Math.max(0, dailyQuota - resendState.countToday),
            quotaExhausted: resendState.quotaExhausted,
            exhaustedReason: resendState.lastExhaustedReason,
            lastFailoverAt: resendState.lastFailoverAt,
        },
        nodemailer: {
            configured: nodemailerConfigured,
            transportType: (process.env.GMAIL_USER || ENV.SMTP_USER) ? 'GMAIL_SSL' : 'CUSTOM_SMTP',
            host: ENV.SMTP_HOST,
            userMasked: (process.env.GMAIL_USER || ENV.SMTP_USER)
                ? (process.env.GMAIL_USER || ENV.SMTP_USER).replace(/^(.{2})(.*)(@.*)$/, '$1***$3')
                : null,
        },
    };
}
export function normalizeRecipients(input) {
    if (!input)
        return [];
    const list = Array.isArray(input) ? input : input.split(/[,;\s]+/);
    return list
        .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
        .filter((e) => e.length > 3 && e.includes('@') && e.includes('.'));
}
async function getOrgInfo() {
    const setting = await AppSetting.findOne().lean();
    return {
        companyName: setting?.companyName || 'Stereobliss',
        storeName: setting?.storeName || 'Stereobliss Central Store',
        currencySymbol: setting?.currencySymbol || '₹',
        contactEmail: setting?.contactEmail || ENV.EMAIL_FROM || 'sales@stereobliss.com',
    };
}
async function resolveRecipients(provided, fallbackReportType) {
    const normalized = normalizeRecipients(provided);
    if (normalized.length > 0) {
        return normalized;
    }
    if (fallbackReportType) {
        const config = await EmailReportConfig.findOne({ reportType: fallbackReportType });
        const fromConfig = normalizeRecipients(config?.recipients);
        if (fromConfig.length > 0) {
            return fromConfig;
        }
    }
    // Fallback to configured Gmail user or Alert Email
    const adminEmail = process.env.GMAIL_USER || ENV.ALERT_EMAIL || ENV.SMTP_USER;
    if (adminEmail && adminEmail.includes('@')) {
        return [adminEmail.trim().toLowerCase()];
    }
    return [];
}
// ─────────────────────────────────────────────────────────────────────────────
// Dedicated Engine Dispatchers
// ─────────────────────────────────────────────────────────────────────────────
async function sendViaResend(org, senderFrom, validRecipients, params) {
    const apiKey = (process.env.RESEND_API_KEY || ENV.RESEND_API_KEY || '').trim();
    if (!apiKey) {
        return { success: false, error: 'No Resend API Key configured' };
    }
    // Determine sender for Resend:
    // If custom RESEND_FROM is set in .env (e.g. "StereoBliss" <sales@stereobliss.com>), prioritize it.
    // Otherwise if senderFrom has a domain, use it; fallback to standard onboarding sandbox for testing.
    let resendFrom = (process.env.RESEND_FROM || ENV.RESEND_FROM || '').trim();
    if (!resendFrom) {
        if (senderFrom && !senderFrom.includes('gmail.com') && !senderFrom.includes('localhost')) {
            resendFrom = senderFrom;
        }
        else {
            resendFrom = `"${org.companyName}" <onboarding@resend.dev>`;
        }
    }
    const resendPayload = {
        from: resendFrom,
        to: validRecipients,
        subject: params.subject,
        html: params.htmlContent,
    };
    if (params.attachments && params.attachments.length > 0) {
        resendPayload.attachments = params.attachments.map((att) => ({
            filename: att.filename,
            content: att.content.toString('base64'),
        }));
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s fast timeout
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(resendPayload),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const data = (await response.json().catch(() => ({})));
        if (response.ok && data?.id) {
            return { success: true, id: data.id };
        }
        const errorMsg = data?.message || data?.error?.message || (typeof data === 'string' ? data : JSON.stringify(data));
        const isQuota = response.status === 429 ||
            response.status === 402 ||
            /quota|rate.?limit|limit.?exceeded|exceeded.*limit|daily.*limit|payment.?required|too.?many.?requests/i.test(errorMsg);
        return {
            success: false,
            error: errorMsg,
            isQuotaExceeded: isQuota,
            statusCode: response.status,
        };
    }
    catch (err) {
        clearTimeout(timeoutId);
        return {
            success: false,
            error: err.name === 'AbortError' ? 'Resend API request timed out after 12s' : (err.message || String(err)),
            isQuotaExceeded: false,
        };
    }
}
async function sendViaNodemailer(senderFrom, validRecipients, params) {
    const transporter = getEmailTransporter();
    if (!transporter) {
        return { success: false, error: 'No Nodemailer SMTP transporter configured' };
    }
    const mailOptions = {
        from: senderFrom,
        to: validRecipients.join(', '),
        subject: params.subject,
        html: params.htmlContent,
    };
    if (params.attachments && params.attachments.length > 0) {
        mailOptions.attachments = params.attachments.map((att) => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType || 'application/pdf',
        }));
    }
    try {
        const info = await transporter.sendMail(mailOptions);
        return { success: true, messageId: info.messageId };
    }
    catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Intelligent Dual-Engine Dispatcher with Automatic Failover
// ─────────────────────────────────────────────────────────────────────────────
export async function sendNotificationEmail(params) {
    // Idempotency check
    if (params.idempotencyKey) {
        const existingLog = await EmailDeliveryLog.findOne({
            idempotencyKey: params.idempotencyKey,
            status: 'SENT',
        });
        if (existingLog) {
            console.log(`[EMAIL] Skipping duplicate email sending for key ${params.idempotencyKey}`);
            return existingLog;
        }
    }
    let status = 'SIMULATED';
    let provider = 'SIMULATED';
    let failoverFrom;
    let failoverReason;
    let errorDetails;
    let providerReference;
    const validRecipients = normalizeRecipients(params.recipients);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL_WARN] No valid recipients provided for "${params.subject}". Skipping email dispatch.`);
        return null;
    }
    const org = await getOrgInfo();
    await ensureResendStateInitialized();
    const apiKey = (process.env.RESEND_API_KEY || ENV.RESEND_API_KEY || '').trim();
    const resendConfigured = Boolean(apiKey && apiKey.startsWith('re_'));
    const dailyQuota = ENV.RESEND_DAILY_QUOTA || 100;
    const canUseResend = resendConfigured && !resendState.quotaExhausted && resendState.countToday < dailyQuota;
    const gmailUser = (process.env.GMAIL_USER || ENV.SMTP_USER || '').trim();
    const rawSender = gmailUser || ENV.EMAIL_FROM || 'sales@stereobliss.com';
    const senderFrom = rawSender.includes('<') ? rawSender : `"${org.companyName}" <${rawSender}>`;
    // 1. PRIMARY ATTEMPT: Resend API
    if (canUseResend) {
        const resendResult = await sendViaResend(org, senderFrom, validRecipients, params);
        if (resendResult.success) {
            status = 'SENT';
            provider = 'RESEND';
            providerReference = resendResult.id;
            resendState.countToday++;
            console.log(`[EMAIL_SENT] "${params.subject}" delivered via Resend API to [${validRecipients.join(', ')}]. ID: ${resendResult.id} (Resend usage today: ${resendState.countToday}/${dailyQuota})`);
        }
        else {
            // Resend failed — classify whether daily quota was exceeded or network error
            if (resendResult.isQuotaExceeded) {
                resendState.quotaExhausted = true;
                resendState.lastExhaustedReason = resendResult.error;
                resendState.lastFailoverAt = new Date();
                console.warn(`[EMAIL_FAILOVER] Resend daily quota/limit reached (${resendResult.error}). Seamlessly switching to Nodemailer SMTP...`);
            }
            else {
                console.warn(`[EMAIL_FAILOVER] Resend delivery encountered error (${resendResult.error}). Attempting immediate fallback to Nodemailer SMTP...`);
            }
            // ── FAILOVER ATTEMPT: Nodemailer SMTP ──
            const nodemailerResult = await sendViaNodemailer(senderFrom, validRecipients, params);
            if (nodemailerResult.success) {
                status = 'SENT';
                provider = 'NODEMAILER';
                failoverFrom = 'RESEND';
                failoverReason = resendResult.error;
                providerReference = nodemailerResult.messageId;
                console.log(`[EMAIL_FAILOVER_SUCCESS] "${params.subject}" delivered via Nodemailer SMTP fallback to [${validRecipients.join(', ')}]. MsgId: ${nodemailerResult.messageId}`);
            }
            else {
                status = 'FAILED';
                errorDetails = `Resend failed (${resendResult.error}); Nodemailer fallback failed (${nodemailerResult.error})`;
                console.error(`[EMAIL_ERROR] Both Resend and Nodemailer failed for "${params.subject}":`, errorDetails);
            }
        }
    }
    else {
        // 2. RESEND NOT AVAILABLE OR DAILY QUOTA ALREADY EXHAUSTED: Route directly to Nodemailer
        if (resendConfigured && (resendState.quotaExhausted || resendState.countToday >= dailyQuota)) {
            console.log(`[EMAIL_ROUTER] Resend daily quota limit active (${resendState.countToday}/${dailyQuota}). Routing directly to Nodemailer SMTP.`);
            failoverFrom = 'RESEND';
            failoverReason = resendState.lastExhaustedReason || `Daily quota of ${dailyQuota} emails reached`;
        }
        const nodemailerResult = await sendViaNodemailer(senderFrom, validRecipients, params);
        if (nodemailerResult.success) {
            status = 'SENT';
            provider = 'NODEMAILER';
            providerReference = nodemailerResult.messageId;
            console.log(`[EMAIL_SENT] "${params.subject}" delivered via Nodemailer SMTP to [${validRecipients.join(', ')}]. MsgId: ${nodemailerResult.messageId}`);
        }
        else {
            if (!getEmailTransporter()) {
                // Neither active Resend nor SMTP credentials configured — simulated mode
                status = 'SIMULATED';
                provider = 'SIMULATED';
                providerReference = `sim-${Date.now()}`;
                console.log(`[EMAIL_SIMULATED] Subject: "${params.subject}" to [${validRecipients.join(', ')}] (Provide RESEND_API_KEY or SMTP credentials in .env for live transmission)`);
            }
            else {
                status = 'FAILED';
                errorDetails = nodemailerResult.error;
                console.error(`[EMAIL_ERROR] Nodemailer delivery failed for "${params.subject}":`, errorDetails);
            }
        }
    }
    const log = await EmailDeliveryLog.create({
        reportType: params.reportType,
        recipients: validRecipients,
        subject: params.subject,
        bodySnippet: params.htmlContent.substring(0, 300).replace(/<[^>]+>/g, ''),
        status,
        provider,
        failoverFrom,
        failoverReason,
        deliveryAttempt: 1,
        providerReference,
        errorDetails,
        idempotencyKey: params.idempotencyKey,
    });
    return log;
}
function renderExecutiveEmailShell(options) {
    const { accentGradient, badgeText, badgeBg, badgeColor, badgeBorder, subtitle, bodyContent, footerStaff, org, } = options;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${org.companyName}</title>
</head>
<body style="margin: 0; padding: 32px 12px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased; line-height: 1.6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
    <tr>
      <td align="center">
        <!-- Main Executive Container Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 630px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04);">
          <!-- Top Radiant Accent Bar -->
          <tr>
            <td style="height: 5px; background: ${accentGradient}; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          <!-- Luxury Dark Brand Header -->
          <tr>
            <td style="background-color: #0b1120; padding: 26px 30px; border-bottom: 1px solid #1e293b;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <div style="font-size: 22px; font-weight: 800; letter-spacing: 2.5px; color: #ffffff; text-transform: uppercase;">
                      ${org.companyName}
                    </div>
                    <div style="font-size: 12px; color: #94a3b8; margin-top: 4px; letter-spacing: 0.3px;">
                      ${org.storeName} &bull; ${subtitle}
                    </div>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; padding: 6px 14px; background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; white-space: nowrap;">
                      ${badgeText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content Body -->
          <tr>
            <td style="padding: 30px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Accountability & Trust Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 22px 30px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; line-height: 1.6;">
              ${footerStaff
        ? `<div style="margin-bottom: 12px; padding: 10px 14px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; color: #475569; font-size: 12px; text-align: left;">
                       <strong>Official Verification:</strong> Authenticated and processed by <strong>${footerStaff.name}</strong> (${footerStaff.role || 'Authorized Management'}) on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.
                     </div>`
        : ''}
              <div style="text-align: center; color: #94a3b8; font-size: 11px;">
                ${org.companyName} &bull; Official Digital Transaction Advice &bull; All rights reserved.<br/>
                For support, assistance or warranty inquiries, write to <a href="mailto:${org.contactEmail}" style="color: #4f46e5; text-decoration: none; font-weight: 600;">${org.contactEmail}</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
function renderMetricHeroCard(options) {
    const { label, amount, subtext, theme = 'emerald' } = options;
    const themes = {
        emerald: { bg: '#ecfdf5', border: '#a7f3d0', text: '#047857', badgeText: '#065f46' },
        amber: { bg: '#fffbeb', border: '#fde68a', text: '#b45309', badgeText: '#92400e' },
        blue: { bg: '#f0f9ff', border: '#bae6fd', text: '#0284c7', badgeText: '#0369a1' },
        indigo: { bg: '#eef2ff', border: '#c7d2fe', text: '#4338ca', badgeText: '#3730a3' },
        rose: { bg: '#fff1f2', border: '#fecdd3', text: '#e11d48', badgeText: '#9f1239' },
    };
    const t = themes[theme];
    return `
  <div style="margin: 22px 0; background: ${t.bg}; border: 1px solid ${t.border}; border-radius: 12px; padding: 20px; text-align: center;">
    <div style="font-size: 11px; font-weight: 800; color: ${t.badgeText}; text-transform: uppercase; letter-spacing: 0.8px;">
      ${label}
    </div>
    <div style="font-size: 32px; font-weight: 900; color: ${t.text}; margin: 8px 0 4px 0; letter-spacing: -0.5px;">
      ${amount}
    </div>
    ${subtext ? `<div style="font-size: 12px; color: #64748b; font-weight: 500;">${subtext}</div>` : ''}
  </div>`;
}
function renderLedgerTable(rows, headerTitle) {
    const headerHtml = headerTitle
        ? `<div style="background: #f1f5f9; border-bottom: 1px solid #e2e8f0; padding: 10px 16px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.6px;">${headerTitle}</div>`
        : '';
    const rowsHtml = rows
        .map((row, idx) => {
        const isLast = idx === rows.length - 1;
        const bg = row.isHighlighted ? row.highlightBg || '#f8fafc' : idx % 2 === 1 ? '#fafafa' : '#ffffff';
        const color = row.highlightColor || '#0f172a';
        const fontWeight = row.isHighlighted ? '700' : '600';
        const valueFormatted = row.isMonospace
            ? `<span style="font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #334155;">${row.value}</span>`
            : row.value;
        return `
      <tr style="background: ${bg};">
        <td style="padding: 11px 16px; color: #64748b; font-size: 13px; width: 44%; ${isLast ? '' : 'border-bottom: 1px solid #e2e8f0;'}">
          ${row.label}
        </td>
        <td style="padding: 11px 16px; font-size: 13px; font-weight: ${fontWeight}; color: ${color}; ${isLast ? '' : 'border-bottom: 1px solid #e2e8f0;'}">
          ${valueFormatted}
        </td>
      </tr>`;
    })
        .join('');
    return `
  <div style="margin: 20px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
    ${headerHtml}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>`;
}
function renderPaymentSupportBox(options) {
    const { org, showPaymentMethods = true } = options;
    if (!showPaymentMethods) {
        return `
    <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; font-size: 12px; color: #475569;">
      <strong>Need help or have questions?</strong> Our team is at your service. Contact us at <a href="mailto:${org.contactEmail}" style="color: #4f46e5; text-decoration: none; font-weight: 600;">${org.contactEmail}</a> or visit the store counter at <strong>${org.storeName}</strong>.
    </div>`;
    }
    return `
  <div style="margin: 20px 0; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; font-size: 12px; color: #1e40af;">
    <div style="font-size: 11px; font-weight: 800; color: #1e3a8a; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px;">
      Payment Options &amp; Assistance
    </div>
    <ul style="margin: 0; padding-left: 18px; line-height: 1.6; color: #1e3a8a;">
      <li><strong>Instant UPI:</strong> Pay via GPay, PhonePe, Paytm or scan the counter QR at ${org.storeName}.</li>
      <li><strong>Store Counter:</strong> Cash, Credit/Debit Card, and NetBanking accepted.</li>
      <li>Instant computer-generated receipts are automatically dispatched upon payment recording.</li>
    </ul>
  </div>`;
}
export async function sendInvoicePdfEmail(params) {
    const { sale } = params;
    const org = await getOrgInfo();
    const recipient = (params.recipientEmail || sale.customerEmail || '').trim();
    if (!recipient || !recipient.includes('@')) {
        throw new Error('Please provide a valid recipient email address.');
    }
    console.log(`[INVOICE_PDF] Generating Tax Invoice PDF for ${sale.invoiceNumber}...`);
    const pdfBuffer = await generateTaxInvoicePdf(sale);
    const pdfFilename = `Tax-Invoice-${sale.invoiceNumber}.pdf`;
    const dateFormatted = new Date(sale.createdAt || Date.now()).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const itemsHtml = (sale.lineItems || [])
        .map((li) => {
        const itemDiscount = (li.discount || 0) * (li.quantity || 1);
        const itemTotal = li.total ?? Math.max(0, li.quantity * li.unitPrice - itemDiscount);
        return `
      <tr>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #0f172a;">
          ${li.product?.name || 'Musical Instrument'}
          ${li.product?.color ? `<span style="color:#64748b; font-size:11px;"> (${li.product.color})</span>` : ''}
          ${itemDiscount > 0 ? `<div style="color: #059669; font-size: 11px; font-weight: 600; margin-top: 2px;">Discount: -${org.currencySymbol}${formatIndianCurrency(itemDiscount)}</div>` : ''}
        </td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-family: monospace; text-align: center; color: #475569;">${li.hsnCode || '92029000'}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: 700; color: #0f172a;">${li.quantity} Nos.</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #475569;">${org.currencySymbol}${formatIndianCurrency(li.unitPrice)}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #0f172a;">${org.currencySymbol}${formatIndianCurrency(itemTotal)}</td>
      </tr>`;
    })
        .join('');
    const grossSubtotal = sale.subtotal || (sale.lineItems || []).reduce((acc, li) => acc + (li.unitPrice || 0) * (li.quantity || 1), 0);
    const discountTotal = sale.discountTotal ?? (sale.lineItems || []).reduce((acc, li) => acc + (li.discount || 0) * (li.quantity || 1), 0);
    const taxableAmount = sale.taxableAmount ?? Math.max(0, grossSubtotal - discountTotal);
    const cgstAmount = sale.cgstAmount ?? Math.round(taxableAmount * 0.09 * 100) / 100;
    const sgstAmount = sale.sgstAmount ?? Math.round(taxableAmount * 0.09 * 100) / 100;
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${sale.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations on your new musical purchase! 🎉 Thank you for choosing <strong>${org.companyName}</strong>. We are delighted to confirm that your order and payment have been successfully processed.
    </p>

    ${renderMetricHeroCard({
        label: sale.isEmi ? 'Initial Down Payment Confirmed' : 'Total Payment Received & Settled',
        amount: `${org.currencySymbol}${formatIndianCurrency(sale.isEmi ? (sale.downPayment || 0) : sale.grandTotal)}`,
        subtext: `Invoice #${sale.invoiceNumber} &bull; Payment Mode: ${sale.paymentMethod || 'UPI'} &bull; ${dateFormatted}`,
        theme: 'emerald',
    })}

    ${renderLedgerTable([
        { label: 'Tax Invoice Number:', value: `#${sale.invoiceNumber}`, isMonospace: true },
        { label: 'Invoice Date:', value: dateFormatted },
        { label: 'Customer Name:', value: sale.customerName },
        { label: 'Purchase Type:', value: sale.isEmi ? `Customer EMI Plan (${sale.emiTenureMonths || 6} Months)` : 'Direct Retail Purchase' },
        { label: 'Payment Method:', value: sale.paymentMethod || 'UPI' },
        ...(sale.isEmi
            ? [
                {
                    label: 'Initial Down Payment Paid:',
                    value: `${org.currencySymbol}${formatIndianCurrency(sale.downPayment || 0)}`,
                    isHighlighted: true,
                    highlightColor: '#047857',
                },
                {
                    label: 'Monthly Installment:',
                    value: `${org.currencySymbol}${formatIndianCurrency(sale.monthlyEmiAmount || 0)} / mo`,
                },
                {
                    label: 'Outstanding EMI Balance:',
                    value: `${org.currencySymbol}${formatIndianCurrency(sale.totalEmiDue || 0)}`,
                    isHighlighted: true,
                    highlightColor: '#b45309',
                },
            ]
            : []),
        {
            label: 'Payment Status:',
            value: sale.paymentStatus === 'PAID' ? '✓ FULLY PAID & SETTLED' : sale.paymentStatus || 'CONFIRMED',
            isHighlighted: true,
            highlightColor: sale.paymentStatus === 'PAID' ? '#047857' : '#b45309',
        },
    ], 'Tax Invoice Details')}

    <!-- Itemized Table Card -->
    <div style="margin: 22px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: #f1f5f9; border-bottom: 1px solid #e2e8f0; padding: 10px 16px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.6px;">
        Purchased Items Summary
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="background: #f8fafc; text-align: left; color: #475569; border-bottom: 1px solid #e2e8f0;">
            <th style="padding: 10px 12px;">Item Description</th>
            <th style="padding: 10px 12px; text-align: center;">HSN</th>
            <th style="padding: 10px 12px; text-align: center;">Qty</th>
            <th style="padding: 10px 12px; text-align: right;">Unit Rate</th>
            <th style="padding: 10px 12px; text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <!-- Financial Calculation Block -->
      <div style="padding: 16px 20px; background: #f8fafc; border-top: 1px solid #e2e8f0; text-align: right; font-size: 13px;">
        <div style="margin-bottom: 5px; color: #64748b;">
          <span>Subtotal: </span>
          <strong style="color: #0f172a;">${org.currencySymbol}${formatIndianCurrency(discountTotal > 0 ? grossSubtotal : taxableAmount)}</strong>
        </div>
        ${discountTotal > 0
        ? `<div style="margin-bottom: 5px; color: #059669; font-weight: 600;">
                 <span>Less Discount Offered: </span>
                 <strong>(-) ${org.currencySymbol}${formatIndianCurrency(discountTotal)}</strong>
               </div>
               <div style="margin-bottom: 5px; color: #64748b;">
                 <span>Taxable Amount: </span>
                 <strong style="color: #0f172a;">${org.currencySymbol}${formatIndianCurrency(taxableAmount)}</strong>
               </div>`
        : ''}
        <div style="margin-bottom: 5px; color: #64748b;">
          <span>GST Breakdown (CGST 9% + SGST 9%): </span>
          <strong style="color: #0f172a;">${org.currencySymbol}${formatIndianCurrency(cgstAmount + sgstAmount)}</strong>
        </div>
        <div style="margin-top: 10px; padding-top: 8px; border-top: 2px solid #e2e8f0;">
          <span style="color: #0f172a; font-weight: 700; font-size: 15px;">Invoice Grand Total: </span>
          <strong style="color: #0f172a; font-size: 20px; margin-left: 8px;">${org.currencySymbol}${formatIndianCurrency(sale.grandTotal)}</strong>
        </div>
        ${sale.isEmi
        ? `<div style="margin-top: 6px; font-size: 13px; color: #059669; font-weight: 600;">
                 <span>Initial Down Payment Paid: </span>
                 <strong style="margin-left: 6px;">(-) ${org.currencySymbol}${formatIndianCurrency(sale.downPayment || 0)}</strong>
               </div>
               <div style="margin-top: 6px; font-size: 14px; color: #b45309; font-weight: 800;">
                 <span>Remaining EMI Financed Balance: </span>
                 <span style="font-size: 16px; margin-left: 6px;">${org.currencySymbol}${formatIndianCurrency(sale.totalEmiDue || Math.max(0, sale.grandTotal - (sale.downPayment || 0)))}</span>
               </div>`
        : ''}
      </div>
    </div>

    <!-- PDF Attachment Callout Card -->
    <div style="margin: 20px 0; padding: 14px 18px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; font-size: 13px; color: #166534; display: flex; align-items: center;">
      <div>
        <strong>📄 Official GST Tax Invoice PDF Attached</strong><br/>
        <span style="font-size: 12px; color: #15803d;">
          Your complete computer-generated tax invoice (${pdfFilename}) with full GST compliance and warranty details is attached to this email.
        </span>
      </div>
    </div>

    ${params.customNotes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 6px; font-size: 13px; color: #92400e;">
             <strong>Note from Store:</strong> ${params.customNotes}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 50%, #d97706 100%)',
        badgeText: '★ OFFICIAL TAX INVOICE & RECEIPT',
        badgeBg: 'rgba(245, 158, 11, 0.15)',
        badgeColor: '#fbbf24',
        badgeBorder: 'rgba(245, 158, 11, 0.3)',
        subtitle: 'Official Tax Invoice & Payment Confirmation',
        bodyContent,
        footerStaff: sale.soldBy ? { name: sale.soldBy.name || 'Sales Staff', role: 'Sales Executive' } : undefined,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.TAX_INVOICE_DISPATCH,
        recipients: [recipient],
        subject: `Congratulations on Your Purchase! Tax Invoice #${sale.invoiceNumber} — ${org.companyName}`,
        htmlContent: html,
        attachments: [
            {
                filename: pdfFilename,
                content: pdfBuffer,
                contentType: 'application/pdf',
            },
        ],
        idempotencyKey: `invoice-email-${sale._id}-${Date.now()}`,
    });
}
// -------------------------------------------------------------
// Interactive & On-Demand Email Report Generators
// -------------------------------------------------------------
export async function sendDailyStockSummary(recipients, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.DAILY_STOCK_SUMMARY);
    if (validRecipients.length === 0) {
        throw new Error('Please specify at least one recipient email address to send this report.');
    }
    const products = await Product.find({ isActive: true }).lean();
    let totalOnHand = 0;
    let totalAvailable = 0;
    let totalValuation = 0;
    const lowStockItems = [];
    for (const p of products) {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        const avail = Math.max(0, (sq.onHand || 0) - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0));
        totalOnHand += sq.onHand || 0;
        totalAvailable += avail;
        totalValuation += (sq.onHand || 0) * (p.purchaseCost || 0);
        if (avail <= (p.minStockThreshold || 5)) {
            lowStockItems.push({ name: p.name, sku: p.sku, available: avail, threshold: p.minStockThreshold || 5 });
        }
    }
    const dateStr = new Date().toLocaleDateString('en-IN', { dateStyle: 'full' });
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px;">${org.companyName}</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.storeName} — Daily Stock &amp; Inventory Summary</div>
      </div>
      <p style="color: #64748b; font-size: 13px;">Report Generated: <strong>${dateStr}</strong></p>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px; font-size: 12px; color: #92400e;">
               <strong>Admin Note:</strong> ${notes}
             </div>`
        : ''}
      
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 20px 0;">
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; border-left: 4px solid #f59e0b;">
          <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Units On Hand</div>
          <div style="font-size: 22px; font-weight: 800; color: #0f172a; margin-top: 4px;">${totalOnHand}</div>
        </div>
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Available For Sale</div>
          <div style="font-size: 22px; font-weight: 800; color: #0f172a; margin-top: 4px;">${totalAvailable}</div>
        </div>
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; border-left: 4px solid #6366f1;">
          <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Valuation (At Cost)</div>
          <div style="font-size: 20px; font-weight: 800; color: #0f172a; margin-top: 4px;">${org.currencySymbol}${totalValuation.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <h3 style="color: #0f172a; font-size: 15px; margin-top: 24px;">Low Stock Items Alert (${lowStockItems.length})</h3>
      ${lowStockItems.length === 0
        ? '<p style="color: #10b981; font-size: 13px; font-weight: 600;">✅ All products are currently stocked above their minimum reorder thresholds.</p>'
        : `<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px;">
              <thead>
                <tr style="background: #f1f5f9; text-align: left; color: #475569;">
                  <th style="padding: 10px; border: 1px solid #e2e8f0;">Product</th>
                  <th style="padding: 10px; border: 1px solid #e2e8f0;">SKU</th>
                  <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Available</th>
                  <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Safety Threshold</th>
                </tr>
              </thead>
              <tbody>
                ${lowStockItems
            .map((i) => `
                  <tr>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; font-weight: 600;">${i.name}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; font-family: monospace; color: #b45309;">${i.sku}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; color: #dc2626; font-weight: 700;">${i.available}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${i.threshold}</td>
                  </tr>`)
            .join('')}
              </tbody>
            </table>`}
      <div style="margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched on demand to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Retail Management
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
        recipients: validRecipients,
        subject: `Daily Stock Summary — ${org.companyName} (${dateStr})`,
        htmlContent: html,
    });
}
export async function sendOverdueUsageReminders(recipients, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.OVERDUE_USAGE_REMINDER);
    if (validRecipients.length === 0) {
        throw new Error('Please specify at least one recipient email address to send this report.');
    }
    const now = new Date();
    const overdueRecords = await InternalUsage.find({
        status: { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED, USAGE_STATUSES.OVERDUE] },
        expectedReturnDate: { $lt: now },
    })
        .populate('items.product', 'name sku')
        .lean();
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #fed7aa; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ea580c; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #c2410c; margin: 0; font-size: 20px;">⚠️ Instrument Loans &amp; Rental Status Alert</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — ${org.storeName}</div>
      </div>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fff7ed; border-left: 4px solid #ea580c; border-radius: 4px; font-size: 12px; color: #9a3412;">
               <strong>Note:</strong> ${notes}
             </div>`
        : ''}
      
      ${overdueRecords.length === 0
        ? `
          <div style="padding: 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; text-align: center; margin: 16px 0;">
            <div style="font-size: 24px; margin-bottom: 6px;">🎉</div>
            <div style="font-size: 15px; font-weight: 700; color: #166534;">Zero Overdue Instrument Loans!</div>
            <div style="font-size: 13px; color: #15803d; margin-top: 4px;">All rented and student loan instruments are currently returned or active within schedule.</div>
          </div>
          `
        : `
          <p style="color: #475569; font-size: 14px;">There are currently <strong>${overdueRecords.length}</strong> equipment issues / student loans that have passed their scheduled return date:</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 16px;">
            <thead>
              <tr style="background: #ffedd5; text-align: left; color: #9a3412;">
                <th style="padding: 10px; border: 1px solid #fdba74;">Issue Ref</th>
                <th style="padding: 10px; border: 1px solid #fdba74;">Responsible Person</th>
                <th style="padding: 10px; border: 1px solid #fdba74;">Purpose</th>
                <th style="padding: 10px; border: 1px solid #fdba74;">Expected Date</th>
              </tr>
            </thead>
            <tbody>
              ${overdueRecords
            .map((r) => `
                <tr>
                  <td style="padding: 10px; border: 1px solid #fed7aa; font-weight: 700; color: #c2410c;">${r.issueReference}</td>
                  <td style="padding: 10px; border: 1px solid #fed7aa;">${r.assignedPerson} ${r.assignedPersonContact ? `<br/><span style="font-size: 11px; color: #64748b;">${r.assignedPersonContact}</span>` : ''}</td>
                  <td style="padding: 10px; border: 1px solid #fed7aa;">${r.purpose}</td>
                  <td style="padding: 10px; border: 1px solid #fed7aa; color: #dc2626; font-weight: 700;">${new Date(r.expectedReturnDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</td>
                </tr>`)
            .join('')}
            </tbody>
          </table>
          `}
      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #fed7aa; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Inventory Control
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
        recipients: validRecipients,
        subject: overdueRecords.length > 0
            ? `⚠️ Alert: ${overdueRecords.length} Overdue Instrument Loans — ${org.companyName}`
            : `✅ Good News: 0 Overdue Instrument Loans — ${org.companyName}`,
        htmlContent: html,
    });
}
export async function sendWeeklySalesSummary(recipients, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.WEEKLY_SALES_SUMMARY);
    if (validRecipients.length === 0) {
        throw new Error('Please specify at least one recipient email address to send this report.');
    }
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const sales = await Sale.find({
        saleStatus: { $ne: 'CANCELLED' },
        createdAt: { $gte: sevenDaysAgo },
    }).lean();
    const totalRevenue = sales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    const totalSalesCount = sales.length;
    const averageOrderValue = totalSalesCount > 0 ? totalRevenue / totalSalesCount : 0;
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #065f46; margin: 0; font-size: 20px;">Weekly Sales Performance Report</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Last 7 Days Performance</div>
      </div>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 4px; font-size: 12px; color: #166534;">
               <strong>Management Note:</strong> ${notes}
             </div>`
        : ''}

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 20px 0;">
        <div style="background: #f0fdf4; padding: 14px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-size: 11px; font-weight: 700; color: #166534; text-transform: uppercase;">Total Sales Revenue</div>
          <div style="font-size: 22px; font-weight: 800; color: #065f46; margin-top: 4px;">${org.currencySymbol}${totalRevenue.toLocaleString('en-IN')}</div>
        </div>
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; border-left: 4px solid #3b82f6;">
          <div style="font-size: 11px; font-weight: 700; color: #1e40af; text-transform: uppercase;">Completed Sales</div>
          <div style="font-size: 22px; font-weight: 800; color: #1e3a8a; margin-top: 4px;">${totalSalesCount}</div>
        </div>
        <div style="background: #f8fafc; padding: 14px; border-radius: 8px; border-left: 4px solid #f59e0b;">
          <div style="font-size: 11px; font-weight: 700; color: #b45309; text-transform: uppercase;">Average Sale Value</div>
          <div style="font-size: 20px; font-weight: 800; color: #78350f; margin-top: 4px;">${org.currencySymbol}${Math.round(averageOrderValue).toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Revenue Reporting
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
        recipients: validRecipients,
        subject: `Weekly Sales Summary: ${org.currencySymbol}${totalRevenue.toLocaleString('en-IN')} (${totalSalesCount} orders) — ${org.companyName}`,
        htmlContent: html,
    });
}
export async function sendLowStockAlert(recipients, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.LOW_STOCK_ALERT);
    if (validRecipients.length === 0) {
        throw new Error('Please specify at least one recipient email address to send this report.');
    }
    const products = await Product.find({ isActive: true }).lean();
    const lowStockItems = [];
    for (const p of products) {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        const avail = Math.max(0, (sq.onHand || 0) - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0));
        if (avail <= (p.minStockThreshold || 5)) {
            lowStockItems.push({
                name: p.name,
                sku: p.sku,
                brand: p.brand,
                available: avail,
                threshold: p.minStockThreshold || 5,
            });
        }
    }
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #fecaca; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #b91c1c; margin: 0; font-size: 20px;">🚨 Low Stock &amp; Reorder Level Report</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Inventory Safety Thresholds</div>
      </div>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; font-size: 12px; color: #991b1b;">
               <strong>Procurement Note:</strong> ${notes}
             </div>`
        : ''}
      
      ${lowStockItems.length === 0
        ? `
          <div style="padding: 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; text-align: center; margin: 16px 0;">
            <div style="font-size: 24px; margin-bottom: 6px;">✅</div>
            <div style="font-size: 15px; font-weight: 700; color: #166534;">Healthy Stock Levels!</div>
            <div style="font-size: 13px; color: #15803d; margin-top: 4px;">All catalog products are currently stocked above their minimum reorder thresholds.</div>
          </div>
          `
        : `
          <p style="color: #475569; font-size: 13px;">The following <strong>${lowStockItems.length}</strong> item(s) have reached or dipped below safety buffer levels:</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 16px;">
            <thead>
              <tr style="background: #fef2f2; text-align: left; color: #991b1b;">
                <th style="padding: 10px; border: 1px solid #fca5a5;">Product Name</th>
                <th style="padding: 10px; border: 1px solid #fca5a5;">SKU</th>
                <th style="padding: 10px; border: 1px solid #fca5a5; text-align: center;">Stock Available</th>
                <th style="padding: 10px; border: 1px solid #fca5a5; text-align: center;">Min Threshold</th>
              </tr>
            </thead>
            <tbody>
              ${lowStockItems
            .map((i) => `
                <tr>
                  <td style="padding: 10px; border: 1px solid #fecaca; font-weight: 600;">${i.name} (${i.brand})</td>
                  <td style="padding: 10px; border: 1px solid #fecaca; font-family: monospace; color: #b91c1c;">${i.sku}</td>
                  <td style="padding: 10px; border: 1px solid #fecaca; text-align: center; color: #dc2626; font-weight: 800;">${i.available}</td>
                  <td style="padding: 10px; border: 1px solid #fecaca; text-align: center;">${i.threshold}</td>
                </tr>`)
            .join('')}
            </tbody>
          </table>
          `}
      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #fecaca; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Stock Management
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.LOW_STOCK_ALERT,
        recipients: validRecipients,
        subject: lowStockItems.length > 0
            ? `🚨 Low Stock Alert: ${lowStockItems.length} Products Need Replenishment — ${org.companyName}`
            : `✅ Inventory Buffer Healthy: 0 Low Stock Items — ${org.companyName}`,
        htmlContent: html,
    });
}
export async function sendValuationReportEmail(recipients, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipients);
    if (validRecipients.length === 0) {
        throw new Error('Please specify at least one recipient email address to send this report.');
    }
    const products = await Product.find({ isActive: true }).populate('category', 'name').lean();
    let totalUnitsOnHand = 0;
    let totalCostValuation = 0;
    let totalRetailValuation = 0;
    const categoryMap = new Map();
    for (const p of products) {
        const qty = p.stockQuantity?.onHand || 0;
        const cost = p.purchaseCost || 0;
        const price = p.defaultSellingPrice || cost;
        totalUnitsOnHand += qty;
        totalCostValuation += qty * cost;
        totalRetailValuation += qty * price;
        const catName = p.category?.name || 'Musical Instruments';
        const current = categoryMap.get(catName) || { count: 0, costVal: 0, retailVal: 0 };
        current.count += qty;
        current.costVal += qty * cost;
        current.retailVal += qty * price;
        categoryMap.set(catName, current);
    }
    const potentialGrossMargin = totalRetailValuation - totalCostValuation;
    const potentialMarginPct = totalRetailValuation > 0 ? Math.round((potentialGrossMargin / totalRetailValuation) * 100) : 0;
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #6366f1; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #312e81; margin: 0; font-size: 20px;">💎 Inventory Asset Valuation Report</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Financial Catalog Asset Worth</div>
      </div>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #eef2ff; border-left: 4px solid #6366f1; border-radius: 4px; font-size: 12px; color: #3730a3;">
               <strong>Valuation Notes:</strong> ${notes}
             </div>`
        : ''}

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0;">
        <div style="background: #eef2ff; padding: 14px; border-radius: 8px; border-left: 4px solid #6366f1;">
          <div style="font-size: 11px; font-weight: 700; color: #4338ca; text-transform: uppercase;">Total Valuation (At Cost)</div>
          <div style="font-size: 22px; font-weight: 800; color: #312e81; margin-top: 4px;">${org.currencySymbol}${totalCostValuation.toLocaleString('en-IN')}</div>
        </div>
        <div style="background: #f0fdf4; padding: 14px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-size: 11px; font-weight: 700; color: #166534; text-transform: uppercase;">Expected Retail Value</div>
          <div style="font-size: 22px; font-weight: 800; color: #065f46; margin-top: 4px;">${org.currencySymbol}${totalRetailValuation.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div style="background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Active Catalog SKUs:</span>
          <strong>${products.length} Products (${totalUnitsOnHand} Physical Units)</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #64748b;">Potential Gross Margin:</span>
          <strong style="color: #10b981;">${org.currencySymbol}${potentialGrossMargin.toLocaleString('en-IN')} (${potentialMarginPct}%)</strong>
        </div>
      </div>

      <h3 style="color: #0f172a; font-size: 14px; text-transform: uppercase;">Valuation Breakdown By Category</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px;">
        <thead>
          <tr style="background: #f1f5f9; text-align: left; color: #475569;">
            <th style="padding: 8px 10px;">Category</th>
            <th style="padding: 8px 10px; text-align: center;">Stock Qty</th>
            <th style="padding: 8px 10px; text-align: right;">Cost Value</th>
            <th style="padding: 8px 10px; text-align: right;">Retail Value</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(categoryMap.entries())
        .map(([cat, data]) => `
            <tr>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${cat}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${data.count}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${data.costVal.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #065f46;">${org.currencySymbol}${data.retailVal.toLocaleString('en-IN')}</td>
            </tr>`)
        .join('')}
        </tbody>
      </table>

      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched on demand to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Asset Intelligence
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.VALUATION_REPORT,
        recipients: validRecipients,
        subject: `Inventory Valuation Report: ${org.currencySymbol}${totalCostValuation.toLocaleString('en-IN')} (Cost) — ${org.companyName}`,
        htmlContent: html,
    });
}
export async function sendRentalProfitabilityReportEmail(recipient, notes) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipient);
    if (validRecipients.length === 0) {
        throw new Error('Please enter a recipient email address for the rental profitability report.');
    }
    const report = await getRentalProfitabilityReport();
    const kpis = report.kpis;
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 680px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #8b5cf6; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #4c1d95; margin: 0; font-size: 20px;">🎸 Rental Instrument Profitability & Fleet Yield Report</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Rental Revenue, Maintenance & Capex Recovery</div>
      </div>
      ${notes
        ? `<div style="margin: 12px 0; padding: 10px 14px; background: #f5f3ff; border-left: 4px solid #8b5cf6; border-radius: 4px; font-size: 12px; color: #5b21b6;">
               <strong>Rental Audit Notes:</strong> ${notes}
             </div>`
        : ''}

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0;">
        <div style="background: #f0fdf4; padding: 14px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-size: 11px; font-weight: 700; color: #166534; text-transform: uppercase;">Total Rental Revenue Collected</div>
          <div style="font-size: 22px; font-weight: 800; color: #065f46; margin-top: 4px;">${org.currencySymbol}${kpis.totalRentalRevenueCollected.toLocaleString('en-IN')}</div>
          <div style="font-size: 11px; color: #047857; margin-top: 2px;">Outstanding Balance: ${org.currencySymbol}${kpis.totalRentalDue.toLocaleString('en-IN')}</div>
        </div>
        <div style="background: #faf5ff; padding: 14px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
          <div style="font-size: 11px; font-weight: 700; color: #6b21a8; text-transform: uppercase;">Net Rental Profit</div>
          <div style="font-size: 22px; font-weight: 800; color: #581c87; margin-top: 4px;">${org.currencySymbol}${kpis.netRentalProfit.toLocaleString('en-IN')}</div>
          <div style="font-size: 11px; color: #7e22ce; margin-top: 2px;">Portfolio Capex Recovery: <strong>${kpis.portfolioRoiPercent}%</strong></div>
        </div>
      </div>

      <div style="background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Active Rental Fleet:</span>
          <strong>${kpis.activeRentals} Active (${kpis.overdueRentals} Overdue, ${kpis.returnedRentals} Returned)</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Monthly Recurring Revenue (MRR):</span>
          <strong style="color: #059669;">${org.currencySymbol}${kpis.activeMRR.toLocaleString('en-IN')}/mo (ARR: ${org.currencySymbol}${kpis.projectedARR.toLocaleString('en-IN')})</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #64748b;">Security Deposits Held:</span>
          <strong>${org.currencySymbol}${kpis.totalSecurityDepositsHeld.toLocaleString('en-IN')}</strong>
        </div>
      </div>

      <h3 style="color: #0f172a; font-size: 14px; text-transform: uppercase;">Category Rental Performance</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px;">
        <thead>
          <tr style="background: #f1f5f9; text-align: left; color: #475569;">
            <th style="padding: 8px 10px;">Category</th>
            <th style="padding: 8px 10px; text-align: center;">Agreements</th>
            <th style="padding: 8px 10px; text-align: right;">Rent Collected</th>
            <th style="padding: 8px 10px; text-align: right;">Capex Cost</th>
            <th style="padding: 8px 10px; text-align: right;">Net Profit</th>
            <th style="padding: 8px 10px; text-align: right;">ROI %</th>
          </tr>
        </thead>
        <tbody>
          ${report.categoryPerformance
        .map((cp) => `
            <tr>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${cp.category}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${cp.rentalsCount}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #047857; font-weight: 700;">${org.currencySymbol}${cp.totalCollected.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${cp.totalCapex.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #6b21a8;">${org.currencySymbol}${cp.netProfit.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${cp.roiPercent}%</td>
            </tr>`)
        .join('')}
        </tbody>
      </table>

      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Dispatched on demand to <strong>${validRecipients.join(', ')}</strong> &bull; ${org.companyName} Rental Asset Management
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_PROFITABILITY_REPORT,
        recipients: validRecipients,
        subject: `Rental Profitability Report: ${org.currencySymbol}${kpis.totalRentalRevenueCollected.toLocaleString('en-IN')} Collected (${kpis.portfolioRoiPercent}% ROI) — ${org.companyName}`,
        htmlContent: html,
    });
}
export async function sendTestEmail(recipient, triggeredBy) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipient);
    if (validRecipients.length === 0) {
        throw new Error('Please enter a recipient email address to send the test email.');
    }
    const engineStatus = await getEmailEngineStatus();
    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' });
    const activeEngineLabel = engineStatus.activeEngine === 'RESEND'
        ? 'Resend API (Primary HTTP Service)'
        : engineStatus.activeEngine === 'NODEMAILER'
            ? 'Nodemailer SMTP (Failover / Direct SMTP)'
            : 'Simulated Engine (Dev / Audit Mode)';
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 24px; border: 1px solid #10b981; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #065f46; margin: 0; font-size: 20px;">✅ Dual-Engine Email System Verification</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — ${org.storeName}</div>
      </div>
      <p style="color: #334155; font-size: 14px; line-height: 1.6;">
        This test confirms that your <strong>Dual-Engine Email Architecture (Resend API Primary + Nodemailer Auto-Failover)</strong> is functioning properly.
      </p>

      <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 16px; border-radius: 6px; margin: 16px 0;">
        <div style="font-size: 12px; color: #166534; font-weight: 700; text-transform: uppercase;">⚡ Active Dispatch Engine: ${activeEngineLabel}</div>
        <div style="font-size: 13px; color: #065f46; margin-top: 8px;">
          Resend Status: <strong>${engineStatus.resend.configured ? 'Configured' : 'Not Set'}</strong> 
          (${engineStatus.resend.usedToday} / ${engineStatus.resend.dailyQuota} used today &bull; ${engineStatus.resend.remainingToday} remaining)
        </div>
        <div style="font-size: 13px; color: #065f46; margin-top: 4px;">
          Nodemailer Failover: <strong>${engineStatus.nodemailer.configured ? 'Active & Ready' : 'Not Configured'}</strong> (${engineStatus.nodemailer.transportType})
        </div>
        <div style="font-size: 13px; color: #065f46; margin-top: 4px;">
          Recipient: <strong>${validRecipients.join(', ')}</strong>
        </div>
        <div style="font-size: 13px; color: #065f46; margin-top: 4px;">
          Dispatched By: <strong>${triggeredBy || 'Administrator'}</strong>
        </div>
        <div style="font-size: 12px; color: #64748b; margin-top: 8px;">Timestamp: ${nowStr}</div>
      </div>

      <div style="font-size: 12px; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; line-height: 1.6;">
        <strong>How Failover Works:</strong> All customer receipts, rental confirmations, and reminders send via Resend API. 
        If your daily free limit (${engineStatus.resend.dailyQuota} emails) is reached or Resend reports rate limiting, our system auto-switches to Nodemailer SMTP instantly with zero message loss.
      </div>

      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Stereobliss Retail Inventory System &bull; Intelligent Dual-Engine Transactional Mailer
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.TEST_EMAIL,
        recipients: validRecipients,
        subject: `✅ Dual-Engine Email Test Succeeded — ${org.companyName} (${new Date().toLocaleTimeString('en-IN')})`,
        htmlContent: html,
    });
}
/**
 * Dispatches an official rent payment reminder email to the rental customer
 */
export async function sendRentalPaymentReminderEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        throw new Error(`Invalid recipient email address: "${params.recipientEmail}"`);
    }
    const formattedDue = params.dueDate
        ? new Date(params.dueDate).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        })
        : 'Immediate';
    const isOverdue = params.daysOverdue && params.daysOverdue > 0;
    const statusLabel = isOverdue ? `⚠ OVERDUE (${params.daysOverdue} DAYS)` : '⏱ RENT PAYMENT DUE';
    const accentGradient = isOverdue
        ? 'linear-gradient(90deg, #dc2626 0%, #ef4444 50%, #b91c1c 100%)'
        : 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 50%, #d97706 100%)';
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      This is a friendly reminder from <strong>${org.storeName}</strong> regarding your rented instrument agreement. Your scheduled rental payment is due for settlement.
    </p>

    ${renderMetricHeroCard({
        label: isOverdue ? 'Overdue Rental Payment Amount' : 'Scheduled Rental Payment Due',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)}`,
        subtext: `Agreement #${params.issueReference} &bull; Due Date: ${formattedDue}`,
        theme: isOverdue ? 'rose' : 'amber',
    })}

    ${renderLedgerTable([
        { label: 'Rented Instrument:', value: `${params.productName}${params.assetId ? ` (Asset: ${params.assetId})` : ''}` },
        { label: 'Agreement Reference:', value: `#${params.issueReference}`, isMonospace: true },
        { label: 'Billing Period:', value: params.billingMonth || 'Current Rental Cycle' },
        {
            label: 'Payment Due Date:',
            value: formattedDue,
            isHighlighted: true,
            highlightColor: isOverdue ? '#dc2626' : '#b45309',
        },
        {
            label: 'Total Amount Due:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)}`,
            isHighlighted: true,
            highlightBg: isOverdue ? '#fef2f2' : '#fffbeb',
            highlightColor: isOverdue ? '#dc2626' : '#b45309',
        },
    ], 'Rental Agreement Schedule')}

    ${params.customNote
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 6px; font-size: 13px; color: #92400e;">
             <strong>Store Note:</strong> ${params.customNote}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: true })}

    <p style="font-size: 12px; color: #64748b; line-height: 1.5; margin-top: 16px;">
      <em>Note: If you have already completed this payment recently, please accept our thanks and disregard this reminder, or reply to this email with your transaction reference for instant receipt generation.</em>
    </p>
  `;
    const html = renderExecutiveEmailShell({
        accentGradient,
        badgeText: statusLabel,
        badgeBg: isOverdue ? 'rgba(220, 38, 38, 0.15)' : 'rgba(245, 158, 11, 0.15)',
        badgeColor: isOverdue ? '#f87171' : '#fbbf24',
        badgeBorder: isOverdue ? 'rgba(220, 38, 38, 0.3)' : 'rgba(245, 158, 11, 0.3)',
        subtitle: 'Musical Instrument Rental Notice',
        bodyContent,
        footerStaff: params.sentBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_PAYMENT_REMINDER,
        recipients: validRecipients,
        subject: `Payment Reminder: ${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)} due for ${params.productName} (${params.issueReference})`,
        htmlContent: html,
    });
}
/**
 * Dispatches an official payment confirmation and receipt email after rent payment is recorded
 */
export async function sendRentalPaymentReceiptEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping payment receipt email: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const formattedPaidAt = new Date(params.paidAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const nextDueText = params.nextDueDate
        ? new Date(params.nextDueDate).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        })
        : 'All Scheduled Tenancy Dues Clear';
    const receiptRef = params.transactionRef || `RCPT-${Date.now().toString().slice(-6)}`;
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Thank you for your payment! 🎉 We have successfully received and verified your rental payment of <strong>${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}</strong> for <strong>${params.productName}</strong>. Your account has been credited and your official rental receipt is below:
    </p>

    ${renderMetricHeroCard({
        label: 'Rental Payment Successfully Received & Confirmed',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}`,
        subtext: `Receipt Ref: ${receiptRef} &bull; Mode: ${params.paymentMethod || 'UPI'} &bull; ${formattedPaidAt}`,
        theme: 'emerald',
    })}

    ${renderLedgerTable([
        {
            label: 'Amount Paid:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}`,
            isHighlighted: true,
            highlightBg: '#ecfdf5',
            highlightColor: '#047857',
        },
        { label: 'Payment Mode:', value: params.paymentMethod || 'UPI' },
        { label: 'Transaction Reference:', value: receiptRef, isMonospace: true },
        { label: 'Payment Date:', value: formattedPaidAt },
        { label: 'Covering Rental Month:', value: params.billingMonth },
        { label: 'Rented Instrument:', value: `${params.productName}${params.assetId ? ` (Asset: ${params.assetId})` : ''}` },
        { label: 'Rental Agreement Ref:', value: `#${params.issueReference}`, isMonospace: true },
        {
            label: 'Total Rent Paid to Date:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.totalRentPaid)}`,
            isHighlighted: true,
            highlightColor: '#047857',
        },
        {
            label: 'Remaining Balance Due:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.totalRentDue)} ${params.totalRentDue === 0 ? '(All Clear — Fully Settled!)' : ''}`,
            isHighlighted: true,
            highlightBg: params.totalRentDue === 0 ? '#f0fdf4' : '#fffbeb',
            highlightColor: params.totalRentDue === 0 ? '#059669' : '#b45309',
        },
        ...(params.totalRentDue > 0
            ? [
                {
                    label: 'Next Scheduled Due Date:',
                    value: nextDueText,
                },
            ]
            : []),
    ], 'Official Rental Payment Ledger')}

    ${params.notes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
             <strong>Payment Notes:</strong> ${params.notes}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #10b981 0%, #34d399 50%, #059669 100%)',
        badgeText: '✓ RENT PAYMENT CONFIRMED',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        badgeBorder: 'rgba(16, 185, 129, 0.3)',
        subtitle: 'Rental Payment Confirmation & Receipt',
        bodyContent,
        footerStaff: params.recordedBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_PAYMENT_CONFIRMATION,
        recipients: allRecipients,
        subject: `Payment Receipt: ${org.currencySymbol}${formatIndianCurrency(params.amountPaid)} received for ${params.productName} (${params.issueReference})`,
        htmlContent: html,
    });
}
/**
 * Dispatches an official Equipment Return & Restocking Confirmation email
 * Triggered when equipment return is inspected and added back into stock
 */
export async function sendRentalReturnConfirmationEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping return confirmation email: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const returnDateFormatted = new Date(params.returnDate || Date.now()).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const depositStatusNote = params.depositRefundStatus === 'REFUND_PENDING'
        ? `<div style="margin: 18px 0; padding: 14px 18px; background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 8px; font-size: 13px; color: #92400e;">
           <strong>💳 Security Deposit Status: Refund Processing Pending (${org.currencySymbol}${formatIndianCurrency(params.depositBalance)})</strong><br/>
           <span style="display: block; margin-top: 6px; line-height: 1.5; color: #78350f;">
             Your equipment return has been logged and your refundable security deposit of <strong>${org.currencySymbol}${formatIndianCurrency(params.depositBalance)}</strong> is queued for disbursement. Our accounts desk will disburse your refund via UPI / Bank Transfer / Cash shortly. You will receive an official refund receipt email once settled.
           </span>
         </div>`
        : params.depositRefundStatus === 'REFUNDED'
            ? `<div style="margin: 18px 0; padding: 14px 18px; background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #10b981; border-radius: 8px; font-size: 13px; color: #065f46;">
           <strong>✓ Security Deposit Status: Fully Settled</strong><br/>
           <span style="display: block; margin-top: 6px; line-height: 1.5; color: #047857;">
             Your security deposit has been fully settled and reconciled. No outstanding dues or refundable balances remain.
           </span>
         </div>`
            : `<div style="margin: 18px 0; padding: 14px 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; color: #475569;">
           <strong>Security Deposit:</strong> Fully utilized towards previous rental months as per agreement terms.
         </div>`;
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Thank you for renting with <strong>${org.companyName}</strong>! We are pleased to confirm that your rented instrument, <strong>${params.productName}</strong>, has been safely returned, inspected by our technical team, and successfully checked back into our active inventory.
    </p>

    ${renderMetricHeroCard({
        label: 'Equipment Return & Restocking Confirmed',
        amount: `${params.returnedItemsCount} Unit${params.returnedItemsCount > 1 ? 's' : ''} Returned`,
        subtext: `Return Ref: #${params.returnReference} &bull; Inspection Date: ${returnDateFormatted}`,
        theme: 'blue',
    })}

    ${renderLedgerTable([
        { label: 'Returned Instrument:', value: `${params.productName}${params.assetId ? ` (Asset: ${params.assetId})` : ''}` },
        { label: 'Agreement Reference:', value: `#${params.issueReference}`, isMonospace: true },
        { label: 'Return Reference:', value: `#${params.returnReference}`, isMonospace: true },
        { label: 'Inspection Date:', value: returnDateFormatted },
        { label: 'Equipment Condition:', value: params.returnCondition || 'Good' },
        { label: 'Inspection Outcome:', value: params.inspectionOutcome === 'AVAILABLE' ? 'Passed Inspection & Restocked' : params.inspectionOutcome || 'Checked In' },
        { label: 'Total Rental Tenancy:', value: `${params.totalMonthsRented} Month(s)` },
        { label: 'Total Rent Paid During Tenancy:', value: `${org.currencySymbol}${formatIndianCurrency(params.totalRentPaid)}`, isHighlighted: true, highlightColor: '#047857' },
    ], 'Equipment Inspection Summary')}

    ${depositStatusNote}

    ${params.notes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
             <strong>Return Inspection Notes:</strong> ${params.notes}
           </div>`
        : ''}

    <p style="font-size: 13px; color: #475569; line-height: 1.6; margin-top: 20px;">
      We sincerely hope you enjoyed playing this instrument. Whenever you are ready for your next musical endeavor, our team at <strong>${org.storeName}</strong> looks forward to serving you again!
    </p>

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #0ea5e9 0%, #38bdf8 50%, #0284c7 100%)',
        badgeText: '✓ EQUIPMENT RETURNED & RESTOCKED',
        badgeBg: 'rgba(14, 165, 233, 0.15)',
        badgeColor: '#38bdf8',
        badgeBorder: 'rgba(14, 165, 233, 0.3)',
        subtitle: 'Equipment Return & Restocking Confirmation',
        bodyContent,
        footerStaff: params.receivedBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_RETURN_CONFIRMATION,
        recipients: allRecipients,
        subject: `Equipment Return Confirmed — ${params.productName} (${params.issueReference}) | ${org.companyName}`,
        htmlContent: html,
    });
}
/**
 * Dispatches an official Security Deposit Refund Confirmation & Receipt email
 * Triggered when deposit refund is processed and disbursed to the customer
 */
export async function sendDepositRefundReceiptEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping deposit refund receipt: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const formattedDate = new Date(params.processedAt || Date.now()).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const deduction = params.deductionAmount || 0;
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations! 🎉 We are pleased to confirm that your security deposit refund for <strong>${params.productName}</strong> (Agreement #${params.issueReference}) has been successfully processed and disbursed to you.
    </p>

    ${renderMetricHeroCard({
        label: 'Security Deposit Refund Disbursed',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.refundAmount)}`,
        subtext: `Disbursed via ${params.paymentMethod} &bull; Trx Ref: ${params.transactionRef} &bull; ${formattedDate}`,
        theme: 'emerald',
    })}

    ${renderLedgerTable([
        { label: 'Rented Instrument:', value: `${params.productName}${params.assetId ? ` (Asset: ${params.assetId})` : ''}` },
        { label: 'Agreement Reference:', value: `#${params.issueReference}`, isMonospace: true },
        { label: 'Initial Security Deposit Paid:', value: `${org.currencySymbol}${formatIndianCurrency(params.initialDeposit)}` },
        { label: 'Deposit Balance Prior to Refund:', value: `${org.currencySymbol}${formatIndianCurrency(params.depositBalanceBefore)}` },
        ...(deduction > 0
            ? [
                {
                    label: `Less: Deductions / Adjustments:`,
                    value: `(-) ${org.currencySymbol}${formatIndianCurrency(deduction)} (${params.deductionReason || 'Adjustment'})`,
                    isHighlighted: true,
                    highlightColor: '#dc2626',
                },
            ]
            : [
                {
                    label: 'Deductions / Damages:',
                    value: '₹0 (Zero Deductions — 100% Full Refund)',
                    isHighlighted: true,
                    highlightColor: '#059669',
                },
            ]),
        {
            label: 'Net Refund Disbursed:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.refundAmount)}`,
            isHighlighted: true,
            highlightBg: '#ecfdf5',
            highlightColor: '#047857',
        },
        { label: 'Payment Method:', value: params.paymentMethod },
        { label: 'Bank / UPI Transaction Reference:', value: params.transactionRef, isMonospace: true },
        { label: 'Disbursement Date:', value: formattedDate },
        {
            label: 'Remaining Deposit Balance:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.depositBalanceAfter)} ${params.depositBalanceAfter === 0 ? '(Agreement Fully Settled & Closed)' : ''}`,
            isHighlighted: true,
            highlightColor: params.depositBalanceAfter === 0 ? '#059669' : '#b45309',
        },
    ], 'Official Security Deposit Refund Statement')}

    ${params.notes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
             <strong>Store Settlement Note:</strong> ${params.notes}
           </div>`
        : ''}

    <div style="margin: 20px 0; padding: 16px 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; font-size: 13px; color: #166534; line-height: 1.6;">
      <strong>Thank you for choosing ${org.companyName}!</strong><br/>
      Your rental account is now completely reconciled and closed with zero outstanding dues. It was a true pleasure having you as our customer. We look forward to supporting your musical journey again soon!
    </div>

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #10b981 0%, #34d399 50%, #059669 100%)',
        badgeText: '✓ DEPOSIT REFUND DISBURSED',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        badgeBorder: 'rgba(16, 185, 129, 0.3)',
        subtitle: 'Security Deposit Refund Confirmation',
        bodyContent,
        footerStaff: params.processedBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_DEPOSIT_REFUND,
        recipients: allRecipients,
        subject: `Refund Disbursed! Security Deposit Refund (${org.currencySymbol}${formatIndianCurrency(params.refundAmount)}) — ${org.companyName}`,
        htmlContent: html,
    });
}
/**
 * High-level router to dispatch any report type by recipient email
 */
export async function dispatchReportEmail(reportType, recipients, options) {
    switch (reportType) {
        case REPORT_TYPES.DAILY_STOCK_SUMMARY:
        case 'summary':
            return await sendDailyStockSummary(recipients, options?.notes);
        case REPORT_TYPES.WEEKLY_SALES_SUMMARY:
        case 'sales':
            return await sendWeeklySalesSummary(recipients, options?.notes);
        case REPORT_TYPES.OVERDUE_USAGE_REMINDER:
        case 'overdue':
            return await sendOverdueUsageReminders(recipients, options?.notes);
        case REPORT_TYPES.LOW_STOCK_ALERT:
        case 'low_stock':
            return await sendLowStockAlert(recipients, options?.notes);
        case REPORT_TYPES.VALUATION_REPORT:
        case 'valuation':
            return await sendValuationReportEmail(recipients, options?.notes);
        case REPORT_TYPES.RENTAL_PROFITABILITY_REPORT:
        case 'rentals':
        case 'rental_profitability':
            return await sendRentalProfitabilityReportEmail(recipients, options?.notes);
        case REPORT_TYPES.TEST_EMAIL:
        case 'test':
            return await sendTestEmail(recipients, options?.triggeredBy);
        default:
            return await sendDailyStockSummary(recipients, options?.notes);
    }
}
/**
 * Dispatches an official EMI payment reminder email to the customer
 */
export async function sendEmiPaymentReminderEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        throw new Error(`Invalid recipient email address: "${params.recipientEmail}"`);
    }
    const formattedDue = params.dueDate
        ? new Date(params.dueDate).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        })
        : 'Immediate';
    const isOverdue = params.daysOverdue && params.daysOverdue > 0;
    const statusLabel = isOverdue ? `⚠ EMI OVERDUE (${params.daysOverdue} DAYS)` : '⏱ EMI PAYMENT DUE';
    const accentGradient = isOverdue
        ? 'linear-gradient(90deg, #dc2626 0%, #ef4444 50%, #b91c1c 100%)'
        : 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 50%, #d97706 100%)';
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      This is a friendly reminder from <strong>${org.storeName}</strong> regarding your purchase EMI installment under Invoice <strong>#${params.invoiceNumber}</strong>. Your scheduled installment payment is due for settlement.
    </p>

    ${renderMetricHeroCard({
        label: isOverdue ? 'Overdue EMI Installment Due' : 'Scheduled Monthly EMI Installment Due',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)}`,
        subtext: `Invoice #${params.invoiceNumber} &bull; Due Date: ${formattedDue}`,
        theme: isOverdue ? 'rose' : 'amber',
    })}

    ${renderLedgerTable([
        { label: 'Purchased Item:', value: params.productName },
        { label: 'Tax Invoice Number:', value: `#${params.invoiceNumber}`, isMonospace: true },
        { label: 'Installment Month:', value: params.billingMonth || 'Scheduled Installment' },
        {
            label: 'Installment Due Date:',
            value: formattedDue,
            isHighlighted: true,
            highlightColor: isOverdue ? '#dc2626' : '#b45309',
        },
        {
            label: 'Total Pending Due:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)}`,
            isHighlighted: true,
            highlightBg: isOverdue ? '#fef2f2' : '#fffbeb',
            highlightColor: isOverdue ? '#dc2626' : '#b45309',
        },
    ], 'EMI Financing Schedule')}

    ${params.customNote
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 6px; font-size: 13px; color: #92400e;">
             <strong>Store Note:</strong> ${params.customNote}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: true })}

    <p style="font-size: 12px; color: #64748b; line-height: 1.5; margin-top: 16px;">
      <em>Note: If you have already completed this payment recently, please accept our thanks and disregard this reminder, or reply to this email with your transaction reference.</em>
    </p>
  `;
    const html = renderExecutiveEmailShell({
        accentGradient,
        badgeText: statusLabel,
        badgeBg: isOverdue ? 'rgba(220, 38, 38, 0.15)' : 'rgba(245, 158, 11, 0.15)',
        badgeColor: isOverdue ? '#f87171' : '#fbbf24',
        badgeBorder: isOverdue ? 'rgba(220, 38, 38, 0.3)' : 'rgba(245, 158, 11, 0.3)',
        subtitle: 'Retail Purchase EMI Financing',
        bodyContent,
        footerStaff: params.sentBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.EMI_PAYMENT_REMINDER,
        recipients: validRecipients,
        subject: `EMI Payment Reminder: ${org.currencySymbol}${formatIndianCurrency(params.pendingAmount)} due for ${params.productName} (${params.invoiceNumber})`,
        htmlContent: html,
    });
}
/**
 * Dispatches an official payment confirmation and receipt email after an EMI payment is recorded
 */
export async function sendEmiPaymentReceiptEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping payment receipt email: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const formattedPaidAt = new Date(params.paidAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const nextDueText = params.nextDueDate
        ? new Date(params.nextDueDate).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        })
        : 'All Scheduled EMIs Completed!';
    const isFullySettled = params.totalEmiDue <= 0;
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations! 🎉 We have successfully received and credited your scheduled EMI installment payment of <strong>${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}</strong> for Invoice <strong>#${params.invoiceNumber}</strong>. Thank you for your continued promptness!
    </p>

    ${renderMetricHeroCard({
        label: 'EMI Installment Received & Confirmed',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}`,
        subtext: `Invoice #${params.invoiceNumber} &bull; Mode: ${params.paymentMethod} &bull; ${formattedPaidAt}`,
        theme: 'emerald',
    })}

    ${renderLedgerTable([
        {
            label: 'Installment Amount Received:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.amountPaid)}`,
            isHighlighted: true,
            highlightBg: '#ecfdf5',
            highlightColor: '#047857',
        },
        { label: 'Payment Mode:', value: params.paymentMethod },
        ...(params.transactionRef
            ? [{ label: 'Transaction Reference:', value: params.transactionRef, isMonospace: true }]
            : []),
        { label: 'Date Received:', value: formattedPaidAt },
        { label: 'Covering Installment:', value: params.billingMonth },
        { label: 'Purchased Item:', value: params.productName },
        { label: 'Invoice Reference:', value: `#${params.invoiceNumber}`, isMonospace: true },
        {
            label: 'Total EMI Paid to Date:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.totalEmiPaid)}`,
            isHighlighted: true,
            highlightColor: '#047857',
        },
        {
            label: 'Remaining Balance Due:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.totalEmiDue)} ${isFullySettled ? '(All Clear — Paid in Full!)' : ''}`,
            isHighlighted: true,
            highlightBg: isFullySettled ? '#f0fdf4' : '#fffbeb',
            highlightColor: isFullySettled ? '#059669' : '#b45309',
        },
        ...(!isFullySettled
            ? [
                {
                    label: 'Next Scheduled EMI Due Date:',
                    value: nextDueText,
                },
            ]
            : []),
    ], 'Official EMI Installment Ledger')}

    ${isFullySettled
        ? `<div style="margin: 20px 0; padding: 18px 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; font-size: 14px; color: #166534; line-height: 1.6; text-align: center;">
             <strong style="font-size: 16px;">🌟 EMI Plan 100% Completed! Congratulations!</strong><br/>
             You have completed all scheduled EMI installments for this instrument. Your purchase is completely paid in full and your ownership is clear. Thank you for being such a wonderful customer of <strong>${org.companyName}</strong>!
           </div>`
        : ''}

    ${params.notes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
             <strong>Receipt Notes:</strong> ${params.notes}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #10b981 0%, #34d399 50%, #059669 100%)',
        badgeText: isFullySettled ? '★ EMI COMPLETED & PAID IN FULL' : '✓ EMI PAYMENT CONFIRMED',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        badgeBorder: 'rgba(16, 185, 129, 0.3)',
        subtitle: 'EMI Payment Confirmation Receipt',
        bodyContent,
        footerStaff: params.recordedBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.EMI_PAYMENT_RECEIPT,
        recipients: allRecipients,
        subject: `EMI Payment Receipt: ${org.currencySymbol}${formatIndianCurrency(params.amountPaid)} received for ${params.productName} (${params.invoiceNumber})`,
        htmlContent: html,
    });
}
/**
 * Sends an official rent-deduction notice to the customer when monthly rent is subtracted from deposit.
 */
export async function sendDepositDeductionNoticeEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        throw new Error(`Invalid recipient email for deposit deduction notice: "${params.recipientEmail}"`);
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const formattedDate = new Date(params.deductedAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const balanceColor = params.depositBalanceAfter <= 0
        ? '#dc2626'
        : params.depositBalanceAfter < params.deductedAmount * 2
            ? '#d97706'
            : '#047857';
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      This is a formal confirmation from <strong>${org.companyName}</strong> that your monthly rental payment of <strong>${org.currencySymbol}${formatIndianCurrency(params.deductedAmount)}</strong> for <strong>${params.billingMonth}</strong> has been automatically adjusted from your security deposit balance on file. No separate payment action is required from you for this period.
    </p>

    ${renderMetricHeroCard({
        label: 'Monthly Rent Adjusted from Deposit',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.deductedAmount)}`,
        subtext: `Covering: ${params.billingMonth} &bull; Processed Date: ${formattedDate} &bull; Agreement #${params.issueReference}`,
        theme: 'indigo',
    })}

    ${renderLedgerTable([
        { label: 'Rented Instrument:', value: `${params.productName}${params.assetId ? ` (Asset: ${params.assetId})` : ''}` },
        { label: 'Agreement Reference:', value: `#${params.issueReference}`, isMonospace: true },
        { label: 'Billing Period Covered:', value: params.billingMonth },
        { label: 'Deposit Balance Before:', value: `${org.currencySymbol}${formatIndianCurrency(params.depositBalanceBefore)}` },
        {
            label: 'Rent Deducted This Month:',
            value: `− ${org.currencySymbol}${formatIndianCurrency(params.deductedAmount)}`,
            isHighlighted: true,
            highlightColor: '#b45309',
        },
        {
            label: 'Remaining Security Deposit Balance:',
            value: `${org.currencySymbol}${formatIndianCurrency(params.depositBalanceAfter)}${params.depositBalanceAfter <= 0 ? ' (Fully Utilised)' : ''}`,
            isHighlighted: true,
            highlightBg: params.depositBalanceAfter <= 0 ? '#fef2f2' : '#f0fdf4',
            highlightColor: balanceColor,
        },
    ], 'Deposit Adjustment Statement')}

    ${params.depositExhausted || params.depositBalanceAfter <= 0
        ? `<div style="margin: 18px 0; padding: 16px 20px; background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; font-size: 13px; color: #991b1b;">
             <strong>⚠ Security Deposit Fully Utilised — Direct Monthly Payments Commencing</strong><br/>
             <span style="display: block; margin-top: 6px; color: #7f1d1d; line-height: 1.5;">
               Your security deposit balance has now been completely utilised across your rental tenancies. To continue your rental uninterrupted, please arrange direct monthly payments (via UPI, Card, or Store Counter) starting next month. Our support desk will be happy to assist you at 
               <a href="mailto:${org.contactEmail}" style="color: #dc2626; font-weight: 600;">${org.contactEmail}</a>.
             </span>
           </div>`
        : `<div style="margin: 18px 0; padding: 14px 18px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; font-size: 13px; color: #166534;">
             <strong>✓ Sufficient Balance:</strong> Your remaining security deposit balance of <strong>${org.currencySymbol}${formatIndianCurrency(params.depositBalanceAfter)}</strong> remains on file for subsequent rental adjustments.
           </div>`}

    ${params.notes
        ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
             <strong>Note from Store:</strong> ${params.notes}
           </div>`
        : ''}

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #6366f1 0%, #818cf8 50%, #4338ca 100%)',
        badgeText: 'ℹ DEPOSIT RENT ADJUSTMENT',
        badgeBg: 'rgba(99, 102, 241, 0.15)',
        badgeColor: '#818cf8',
        badgeBorder: 'rgba(99, 102, 241, 0.3)',
        subtitle: 'Rental Security Deposit Statement',
        bodyContent,
        footerStaff: params.sentBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_DEPOSIT_DEDUCTION_NOTICE,
        recipients: allRecipients,
        subject: `Rent Deducted from Deposit — ${params.billingMonth} | ${params.productName} (${params.issueReference})`,
        htmlContent: html,
    });
}
/**
 * Sends a welcome / agreement confirmation email to the customer when a rental is created.
 */
export async function sendRentalAgreementWelcomeEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping rental welcome email: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const returnDate = new Date(params.expectedReturnDate).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const totalDeposit = formatIndianCurrency(params.securityDeposit);
    const monthlyRent = formatIndianCurrency(params.monthlyRent);
    const depositModeNote = params.depositMode
        ? `Your security deposit of ${org.currencySymbol}${totalDeposit} will be automatically utilised as monthly rent payments (${org.currencySymbol}${monthlyRent}/mo). No separate monthly transfer is required during the lock-in period.`
        : `Your monthly rent of ${org.currencySymbol}${monthlyRent} is payable at the start of each month. A digital receipt will be emailed immediately upon each settlement.`;
    const accessoriesHtml = params.includedAccessories.length > 0
        ? params.includedAccessories
            .map((a) => `<li style="padding: 3px 0; color: #334155;"><strong>✓</strong> ${a}</li>`)
            .join('')
        : '<li style="color: #64748b;">Standard instrument package (no additional accessories)</li>';
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations and welcome to <strong>${org.companyName}</strong>! 🎉 We are thrilled to confirm your musical instrument rental agreement for the <strong>${params.productName}</strong>. Everything has been professionally inspected, cleaned, and tested for you.
    </p>

    ${renderMetricHeroCard({
        label: 'Monthly Rental Commitment',
        amount: `${org.currencySymbol}${monthlyRent} / mo`,
        subtext: `Agreement #${params.issueReference} &bull; Lock-in Tenure: ${params.lockInPeriodMonths} Month(s)`,
        theme: 'amber',
    })}

    ${renderLedgerTable([
        { label: 'Rented Instrument:', value: params.productName },
        { label: 'Agreement Reference:', value: `#${params.issueReference}`, isMonospace: true },
        { label: 'Lock-In Commitment:', value: `${params.lockInPeriodMonths} Month${params.lockInPeriodMonths > 1 ? 's' : ''}` },
        { label: 'Agreement Expected End Date:', value: returnDate },
        {
            label: 'Monthly Rental Rate:',
            value: `${org.currencySymbol}${monthlyRent} / month`,
            isHighlighted: true,
            highlightColor: '#b45309',
        },
        {
            label: 'Security Deposit Paid:',
            value: `${org.currencySymbol}${totalDeposit} (Txn: ${params.depositTransactionRef || 'Counter Verified'})`,
            isHighlighted: true,
            highlightColor: '#047857',
        },
        {
            label: 'Rental Payment Mode:',
            value: params.depositMode ? 'Deposit-as-Rent (Auto-deducted monthly)' : 'Direct Monthly Settlement',
        },
    ], 'Rental Agreement Overview')}

    <!-- Terms Explainer Card -->
    <div style="margin: 18px 0; padding: 16px 20px; background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 8px; font-size: 13px; color: #78350f;">
      <strong style="color: #92400e;">Payment &amp; Tenancy Terms:</strong><br/>
      <span style="display: block; margin-top: 6px; line-height: 1.6;">${depositModeNote}</span>
    </div>

    <!-- Bundled Accessories Card -->
    <div style="margin: 18px 0; padding: 16px 20px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;">
      <div style="font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px;">
        Bundled Accessories Included
      </div>
      <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; list-style-type: none;">
        ${accessoriesHtml}
      </ul>
    </div>

    <p style="font-size: 13px; color: #475569; line-height: 1.6; margin-top: 20px;">
      We hope this instrument brings you immense joy and musical inspiration. If you ever have questions or require accessories, our team is always here for you!
    </p>

    ${renderPaymentSupportBox({ org, showPaymentMethods: false })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 50%, #d97706 100%)',
        badgeText: '★ RENTAL AGREEMENT CONFIRMED',
        badgeBg: 'rgba(245, 158, 11, 0.15)',
        badgeColor: '#fbbf24',
        badgeBorder: 'rgba(245, 158, 11, 0.3)',
        subtitle: 'Rental Agreement Confirmation',
        bodyContent,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_PAYMENT_REMINDER,
        recipients: allRecipients,
        subject: `Rental Agreement Confirmed — ${params.productName} | ${params.issueReference}`,
        htmlContent: html,
    });
}
/**
 * Sends a notice to the customer when their security deposit has been fully exhausted.
 */
export async function sendDepositExhaustionEmail(params) {
    const org = await getOrgInfo();
    const validRecipients = normalizeRecipients(params.recipientEmail);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL] Skipping deposit exhaustion email: invalid recipient "${params.recipientEmail}"`);
        return null;
    }
    const storeRecipients = normalizeRecipients(org.contactEmail);
    const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));
    const bodyContent = `
    <p style="font-size: 16px; line-height: 1.6; margin-top: 0; color: #0f172a;">
      Dear <strong>${params.customerName}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your security deposit for the rental of <strong>${params.productName}</strong> (Ref: <strong>#${params.issueReference}</strong>) has been <strong style="color: #dc2626;">fully utilised</strong> as of <strong>${params.lastBillingMonth}</strong>.
    </p>

    ${renderMetricHeroCard({
        label: 'Direct Monthly Rent Now Active',
        amount: `${org.currencySymbol}${formatIndianCurrency(params.monthlyRent)} / mo`,
        subtext: `Agreement #${params.issueReference} &bull; Commences from next billing cycle`,
        theme: 'rose',
    })}

    <div style="margin: 20px 0; padding: 16px 20px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; font-size: 13px; color: #991b1b;">
      <strong>What this means:</strong>
      <ul style="margin: 8px 0 0 0; padding-left: 20px; line-height: 1.8;">
        <li>Your initial deposit has been completely applied towards your scheduled monthly rent payments.</li>
        <li>To continue enjoying your instrument rental, direct monthly payments of <strong>${org.currencySymbol}${formatIndianCurrency(params.monthlyRent)}</strong> will now apply.</li>
        <li>You can easily pay via UPI, Card, or at the store counter before each monthly due date.</li>
      </ul>
    </div>

    ${renderPaymentSupportBox({ org, showPaymentMethods: true })}
  `;
    const html = renderExecutiveEmailShell({
        accentGradient: 'linear-gradient(90deg, #dc2626 0%, #ef4444 50%, #b91c1c 100%)',
        badgeText: '⚠ CONTINUATION NOTICE',
        badgeBg: 'rgba(220, 38, 38, 0.15)',
        badgeColor: '#f87171',
        badgeBorder: 'rgba(220, 38, 38, 0.3)',
        subtitle: 'Security Deposit Exhaustion Notice',
        bodyContent,
        footerStaff: params.sentBy,
        org,
    });
    return sendNotificationEmail({
        reportType: REPORT_TYPES.RENTAL_DEPOSIT_DEDUCTION_NOTICE,
        recipients: allRecipients,
        subject: `Deposit Fully Utilised — Continuation Rent Required | ${params.issueReference}`,
        htmlContent: html,
    });
}
