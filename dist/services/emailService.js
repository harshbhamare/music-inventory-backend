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
    let errorDetails;
    let providerReference;
    const validRecipients = normalizeRecipients(params.recipients);
    if (validRecipients.length === 0) {
        console.warn(`[EMAIL_WARN] No valid recipients provided for "${params.subject}". Skipping email dispatch.`);
        return null;
    }
    const org = await getOrgInfo();
    const transporter = getEmailTransporter();
    const gmailUser = (process.env.GMAIL_USER || ENV.SMTP_USER || '').trim();
    const rawSender = gmailUser || ENV.EMAIL_FROM || 'sales@stereobliss.com';
    const senderFrom = rawSender.includes('<') ? rawSender : `"${org.companyName}" <${rawSender}>`;
    if (transporter) {
        // Delivery via configured Gmail SSL or SMTP
        try {
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
            const info = await transporter.sendMail(mailOptions);
            status = 'SENT';
            providerReference = info.messageId;
            console.log(`[EMAIL_SENT] "${params.subject}" sent via SMTP to [${validRecipients.join(', ')}]. MsgId: ${info.messageId}`);
        }
        catch (err) {
            status = 'FAILED';
            errorDetails = err.message || String(err);
            console.error(`[EMAIL_ERROR] SMTP delivery failed for "${params.subject}":`, err);
        }
    }
    else if (ENV.RESEND_API_KEY) {
        // Delivery via Resend API
        try {
            const resendPayload = {
                from: senderFrom,
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
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(resendPayload),
            });
            const data = (await response.json());
            if (response.ok) {
                status = 'SENT';
                providerReference = data.id;
                console.log(`[EMAIL_SENT] "${params.subject}" sent via Resend API to [${validRecipients.join(', ')}]. ID: ${data.id}`);
            }
            else {
                status = 'FAILED';
                errorDetails = data.message || JSON.stringify(data);
                console.error(`[EMAIL_ERROR] Resend API error:`, data);
            }
        }
        catch (err) {
            status = 'FAILED';
            errorDetails = err.message;
            console.error(`[EMAIL_ERROR] Resend API request failed:`, err);
        }
    }
    else {
        // Simulated mode with full audit logging
        status = 'SIMULATED';
        providerReference = `sim-${Date.now()}`;
        console.log(`[EMAIL_SIMULATED] Subject: "${params.subject}" to [${validRecipients.join(', ')}] (Add Gmail app password or SMTP in .env for real delivery)`);
    }
    const log = await EmailDeliveryLog.create({
        reportType: params.reportType,
        recipients: validRecipients,
        subject: params.subject,
        bodySnippet: params.htmlContent.substring(0, 300).replace(/<[^>]+>/g, ''),
        status,
        deliveryAttempt: 1,
        providerReference,
        errorDetails,
        idempotencyKey: params.idempotencyKey,
    });
    return log;
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
        dateStyle: 'medium',
    });
    const itemsHtml = (sale.lineItems || [])
        .map((li) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">
          ${li.product?.name || 'Musical Instrument'}
          ${li.product?.color ? `<span style="color:#64748b; font-size:11px;"> (${li.product.color})</span>` : ''}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-family: monospace; text-align: center;">${li.hsnCode || '92029000'}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: 700;">${li.quantity} Nos.</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${formatIndianCurrency(li.unitPrice)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${org.currencySymbol}${formatIndianCurrency(li.total || (li.quantity * li.unitPrice))}</td>
      </tr>`)
        .join('');
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 16px; margin-bottom: 20px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px;">${org.companyName.toUpperCase()}</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">Official Tax Invoice &amp; Payment Confirmation</div>
      </div>

      <p style="color: #334155; font-size: 14px; line-height: 1.5;">
        Dear <strong>${sale.customerName}</strong>,
      </p>
      <p style="color: #475569; font-size: 13px; line-height: 1.5;">
        Thank you for your business. Please find attached the official computer-generated <strong>Tax Invoice (${sale.invoiceNumber})</strong> with complete GST breakdown and warranty details in PDF format.
      </p>

      <div style="background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; padding: 14px; margin: 20px 0; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Invoice Number:</span>
          <strong style="color: #b45309; font-family: monospace;">#${sale.invoiceNumber}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Invoice Date:</span>
          <strong>${dateFormatted}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Payment Method:</span>
          <strong>${sale.paymentMethod || 'UPI'}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #64748b;">Payment Status:</span>
          <strong style="color: #10b981;">PAID</strong>
        </div>
      </div>

      <h3 style="color: #0f172a; font-size: 14px; margin-top: 20px; text-transform: uppercase; letter-spacing: 0.5px;">Invoice Summary</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px;">
        <thead>
          <tr style="background: #f1f5f9; text-align: left; color: #475569;">
            <th style="padding: 8px 10px;">Item</th>
            <th style="padding: 8px 10px; text-align: center;">HSN</th>
            <th style="padding: 8px 10px; text-align: center;">Qty</th>
            <th style="padding: 8px 10px; text-align: right;">Rate</th>
            <th style="padding: 8px 10px; text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid #e2e8f0; text-align: right; font-size: 14px;">
        <span style="color: #64748b; font-weight: 600;">Grand Total: </span>
        <strong style="color: #0f172a; font-size: 18px; margin-left: 8px;">${org.currencySymbol}${formatIndianCurrency(sale.grandTotal)}</strong>
      </div>

      ${params.customNotes
        ? `<div style="margin-top: 16px; padding: 12px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; font-size: 12px; color: #92400e;">
               <strong>Note from seller:</strong> ${params.customNotes}
             </div>`
        : ''}

      <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        The complete Tax Invoice has been attached as a PDF to this email.<br/>
        ${org.companyName} — ${org.storeName}. All rights reserved.
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.TAX_INVOICE_DISPATCH,
        recipients: [recipient],
        subject: `Tax Invoice #${sale.invoiceNumber} — ${org.companyName}`,
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
export async function sendTestEmail(recipient, triggeredBy) {
    const org = await getOrgInfo();
    const validRecipients = await resolveRecipients(recipient);
    if (validRecipients.length === 0) {
        throw new Error('Please enter a recipient email address to send the test email.');
    }
    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' });
    const gmailUser = process.env.GMAIL_USER || ENV.SMTP_USER;
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #10b981; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #065f46; margin: 0; font-size: 20px;">✅ Gmail SMTP Operational Test</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — ${org.storeName}</div>
      </div>
      <p style="color: #334155; font-size: 14px; line-height: 1.6;">
        This email confirms that your <strong>Google App Password and Gmail SMTP delivery service</strong> are functioning properly.
      </p>
      <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 14px; border-radius: 6px; margin: 16px 0;">
        <div style="font-size: 12px; color: #166534; font-weight: 700; text-transform: uppercase;">Delivery Status: VERIFIED ACTIVE</div>
        <div style="font-size: 13px; color: #065f46; margin-top: 6px;">Sender Account: <strong>${gmailUser}</strong></div>
        <div style="font-size: 13px; color: #065f46; margin-top: 2px;">Recipient: <strong>${validRecipients.join(', ')}</strong></div>
        <div style="font-size: 13px; color: #065f46; margin-top: 2px;">Dispatched By: <strong>${triggeredBy || 'Administrator'}</strong></div>
        <div style="font-size: 12px; color: #64748b; margin-top: 6px;">Timestamp: ${nowStr}</div>
      </div>
      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Stereobliss Retail Inventory System &bull; Secure Transactional Dispatch
      </div>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.TEST_EMAIL,
        recipients: validRecipients,
        subject: `✅ Gmail SMTP Test Succeeded — ${org.companyName} (${new Date().toLocaleTimeString('en-IN')})`,
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
        case REPORT_TYPES.TEST_EMAIL:
        case 'test':
            return await sendTestEmail(recipients, options?.triggeredBy);
        default:
            return await sendDailyStockSummary(recipients, options?.notes);
    }
}
