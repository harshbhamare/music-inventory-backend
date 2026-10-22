import nodemailer, { Transporter } from 'nodemailer';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { Sale, ISale } from '../models/Sale.js';
import { AppSetting } from '../models/AppSetting.js';
import {
  REPORT_TYPES,
  ReportType,
  USAGE_STATUSES,
} from '../config/constants.js';
import { ENV } from '../config/env.js';
import { generateTaxInvoicePdf, formatIndianCurrency } from './pdfService.js';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailParams {
  reportType: ReportType;
  recipients: string[];
  subject: string;
  htmlContent: string;
  attachments?: EmailAttachment[];
  idempotencyKey?: string;
}

let cachedTransporter: Transporter | null = null;

function getEmailTransporter(): Transporter | null {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  // 1. Check custom SMTP host & user credentials
  if (ENV.SMTP_HOST && ENV.SMTP_USER) {
    try {
      cachedTransporter = nodemailer.createTransport({
        host: ENV.SMTP_HOST,
        port: ENV.SMTP_PORT,
        secure: ENV.SMTP_SECURE,
        auth: {
          user: ENV.SMTP_USER,
          pass: ENV.SMTP_PASS,
        },
      });
      console.log(`[EMAIL_INIT] Configured Nodemailer SMTP transporter (${ENV.SMTP_HOST}:${ENV.SMTP_PORT})`);
      return cachedTransporter;
    } catch (err) {
      console.error('[EMAIL_INIT_ERROR] Failed to initialize SMTP transporter:', err);
    }
  }

  // 2. Check direct Gmail user & password
  const gmailUser = process.env.GMAIL_USER || (ENV.SMTP_USER.includes('@gmail.com') ? ENV.SMTP_USER : '');
  const gmailPass = process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || (ENV.SMTP_USER.includes('@gmail.com') ? ENV.SMTP_PASS : '');

  if (gmailUser && gmailPass) {
    try {
      cachedTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser,
          pass: gmailPass,
        },
      });
      console.log(`[EMAIL_INIT] Configured Nodemailer Gmail transporter for ${gmailUser}`);
      return cachedTransporter;
    } catch (err) {
      console.error('[EMAIL_INIT_ERROR] Failed to initialize Gmail transporter:', err);
    }
  }

  return null;
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

export async function sendNotificationEmail(params: SendEmailParams) {
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

  let status: 'SENT' | 'SIMULATED' | 'FAILED' = 'SIMULATED';
  let errorDetails: string | undefined;
  let providerReference: string | undefined;

  const validRecipients = params.recipients.filter((r) => r && typeof r === 'string' && r.trim().includes('@'));

  if (validRecipients.length === 0) {
    console.warn(`[EMAIL_WARN] No valid recipients provided for "${params.subject}". Skipping email dispatch.`);
    return null;
  }

  const transporter = getEmailTransporter();
  const senderFrom = ENV.EMAIL_FROM || 'sales@stereobliss.com';

  if (transporter) {
    // Delivery via configured SMTP or Gmail
    try {
      const mailOptions: any = {
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
    } catch (err: any) {
      status = 'FAILED';
      errorDetails = err.message || String(err);
      console.error(`[EMAIL_ERROR] SMTP delivery failed for "${params.subject}":`, err);
    }
  } else if (ENV.RESEND_API_KEY) {
    // Delivery via Resend API
    try {
      const resendPayload: any = {
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

      const data = (await response.json()) as any;
      if (response.ok) {
        status = 'SENT';
        providerReference = data.id;
        console.log(`[EMAIL_SENT] "${params.subject}" sent via Resend API to [${validRecipients.join(', ')}]. ID: ${data.id}`);
      } else {
        status = 'FAILED';
        errorDetails = data.message || JSON.stringify(data);
        console.error(`[EMAIL_ERROR] Resend API error:`, data);
      }
    } catch (err: any) {
      status = 'FAILED';
      errorDetails = err.message;
      console.error(`[EMAIL_ERROR] Resend API request failed:`, err);
    }
  } else {
    // Safe simulated mode with full database audit logging
    status = 'SIMULATED';
    providerReference = `sim-${Date.now()}`;
    console.log(
      `[EMAIL_SIMULATED] Subject: "${params.subject}" to [${validRecipients.join(', ')}] (Add SMTP or Resend credentials to .env to send real emails)`
    );
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

// -------------------------------------------------------------
// Transactional Billing / PDF Invoicing Email
// -------------------------------------------------------------

export interface SendInvoiceEmailParams {
  sale: any;
  recipientEmail?: string;
  customNotes?: string;
}

export async function sendInvoicePdfEmail(params: SendInvoiceEmailParams) {
  const { sale } = params;
  const org = await getOrgInfo();

  const recipient = (params.recipientEmail || sale.customerEmail || '').trim();
  if (!recipient || !recipient.includes('@')) {
    throw new Error('Please provide a valid recipient email address.');
  }

  // Generate high-resolution PDF matching the Indian GST format
  console.log(`[INVOICE_PDF] Generating Tax Invoice PDF for ${sale.invoiceNumber}...`);
  const pdfBuffer = await generateTaxInvoicePdf(sale);
  const pdfFilename = `Tax-Invoice-${sale.invoiceNumber}.pdf`;

  const dateFormatted = new Date(sale.createdAt || Date.now()).toLocaleDateString('en-IN', {
    dateStyle: 'medium',
  });

  const itemsHtml = (sale.lineItems || [])
    .map(
      (li: any) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">
          ${li.product?.name || 'Musical Instrument'}
          ${li.product?.color ? `<span style="color:#64748b; font-size:11px;"> (${li.product.color})</span>` : ''}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-family: monospace; text-align: center;">${li.hsnCode || '92029000'}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: 700;">${li.quantity} Nos.</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${formatIndianCurrency(li.unitPrice)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${org.currencySymbol}${formatIndianCurrency(li.total || (li.quantity * li.unitPrice))}</td>
      </tr>`
    )
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

      ${
        params.customNotes
          ? `<div style="margin-top: 16px; padding: 12px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; font-size: 12px; color: #92400e;">
               <strong>Note from seller:</strong> ${params.customNotes}
             </div>`
          : ''
      }

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
// Scheduled Cron Report Dispatches (Clean: Zero Hardcoded Default Emails)
// -------------------------------------------------------------

export async function sendDailyStockSummary(recipients?: string[]) {
  const org = await getOrgInfo();
  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY });

  const targetRecipients = (recipients && recipients.length > 0) ? recipients : (config?.recipients || []);
  const validRecipients = targetRecipients.filter((r) => r && typeof r === 'string' && r.trim().includes('@'));

  if (validRecipients.length === 0) {
    console.log('[CRON] Daily Stock Summary has no configured recipients. Skipping dispatch until user adds email addresses.');
    return null;
  }

  const products = await Product.find({ isActive: true }).lean();
  let totalOnHand = 0;
  let totalAvailable = 0;
  let totalValuation = 0;
  const lowStockItems: any[] = [];

  for (const p of products) {
    const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
    const avail = Math.max(0, (sq.onHand || 0) - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0));
    totalOnHand += sq.onHand || 0;
    totalAvailable += avail;
    totalValuation += (sq.onHand || 0) * (p.purchaseCost || 0);
    if (avail <= (p.minStockThreshold || 5)) {
      lowStockItems.push({ name: p.name, sku: p.sku, available: avail, threshold: p.minStockThreshold });
    }
  }

  const dateStr = new Date().toLocaleDateString('en-IN', { dateStyle: 'full' });
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px;">${org.companyName}</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.storeName} — Daily Stock &amp; Inventory Summary</div>
      </div>
      <p style="color: #64748b; font-size: 13px;">Date: <strong>${dateStr}</strong></p>
      
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
      ${
        lowStockItems.length === 0
          ? '<p style="color: #10b981; font-size: 13px;">✅ All products are currently stocked above their minimum reorder thresholds.</p>'
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
                  .map(
                    (i) => `
                  <tr>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; font-weight: 600;">${i.name}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; font-family: monospace; color: #b45309;">${i.sku}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; color: #dc2626; font-weight: 700;">${i.available}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${i.threshold}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
      <div style="margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        Automated report dispatched by ${org.companyName} Inventory Control System.
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

export async function sendOverdueUsageReminders(recipients?: string[]) {
  const org = await getOrgInfo();
  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER });

  const targetRecipients = (recipients && recipients.length > 0) ? recipients : (config?.recipients || []);
  const validRecipients = targetRecipients.filter((r) => r && typeof r === 'string' && r.trim().includes('@'));

  if (validRecipients.length === 0) {
    console.log('[CRON] Overdue Usage Reminders has no configured recipients. Skipping dispatch until user adds email addresses.');
    return null;
  }

  const now = new Date();
  const overdueRecords = await InternalUsage.find({
    status: { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED, USAGE_STATUSES.OVERDUE] },
    expectedReturnDate: { $lt: now },
  })
    .populate('items.product', 'name sku')
    .lean();

  if (overdueRecords.length === 0) {
    return null;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #fed7aa; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ea580c; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #c2410c; margin: 0; font-size: 20px;">⚠️ Overdue Instrument Returns Alert</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — ${org.storeName}</div>
      </div>
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
            .map(
              (r) => `
            <tr>
              <td style="padding: 10px; border: 1px solid #fed7aa; font-weight: 700; color: #c2410c;">${r.issueReference}</td>
              <td style="padding: 10px; border: 1px solid #fed7aa;">${r.assignedPerson} ${r.assignedPersonContact ? `<br/><span style="font-size: 11px; color: #64748b;">${r.assignedPersonContact}</span>` : ''}</td>
              <td style="padding: 10px; border: 1px solid #fed7aa;">${r.purpose}</td>
              <td style="padding: 10px; border: 1px solid #fed7aa; color: #dc2626; font-weight: 700;">${new Date(r.expectedReturnDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #fed7aa; font-size: 11px; color: #94a3b8; text-align: center;">
        Automated alert from ${org.companyName} Inventory Management.
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
    recipients: validRecipients,
    subject: `⚠️ Alert: ${overdueRecords.length} Overdue Instrument Loans — ${org.companyName}`,
    htmlContent: html,
  });
}

export async function sendWeeklySalesSummary(recipients?: string[]) {
  const org = await getOrgInfo();
  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY });

  const targetRecipients = (recipients && recipients.length > 0) ? recipients : (config?.recipients || []);
  const validRecipients = targetRecipients.filter((r) => r && typeof r === 'string' && r.trim().includes('@'));

  if (validRecipients.length === 0) {
    console.log('[CRON] Weekly Sales Summary has no configured recipients. Skipping dispatch until user adds email addresses.');
    return null;
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const sales = await Sale.find({
    status: { $ne: 'CANCELLED' },
    createdAt: { $gte: sevenDaysAgo },
  }).lean();

  const totalRevenue = sales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
  const totalSalesCount = sales.length;
  const averageOrderValue = totalSalesCount > 0 ? totalRevenue / totalSalesCount : 0;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #065f46; margin: 0; font-size: 20px;">Weekly Sales Performance</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Last 7 Days Performance</div>
      </div>

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
        Weekly automated revenue report for ${org.companyName}.
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY,
    recipients: validRecipients,
    subject: `Weekly Sales Summary: ${org.currencySymbol}${totalRevenue.toLocaleString('en-IN')} — ${org.companyName}`,
    htmlContent: html,
  });
}

export async function sendLowStockAlert(recipients?: string[]) {
  const org = await getOrgInfo();
  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.LOW_STOCK_ALERT });

  const targetRecipients = (recipients && recipients.length > 0) ? recipients : (config?.recipients || []);
  const validRecipients = targetRecipients.filter((r) => r && typeof r === 'string' && r.trim().includes('@'));

  if (validRecipients.length === 0) {
    console.log('[CRON] Low Stock Alert has no configured recipients. Skipping dispatch until user adds email addresses.');
    return null;
  }

  const products = await Product.find({ isActive: true }).lean();
  const lowStockItems: any[] = [];

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

  if (lowStockItems.length === 0) {
    return null;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #fecaca; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #b91c1c; margin: 0; font-size: 20px;">🚨 Urgent: Low Stock Reorder Alert</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — ${lowStockItems.length} product(s) reached safety threshold</div>
      </div>
      
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
            .map(
              (i) => `
            <tr>
              <td style="padding: 10px; border: 1px solid #fecaca; font-weight: 600;">${i.name} (${i.brand})</td>
              <td style="padding: 10px; border: 1px solid #fecaca; font-family: monospace; color: #b91c1c;">${i.sku}</td>
              <td style="padding: 10px; border: 1px solid #fecaca; text-align: center; color: #dc2626; font-weight: 800;">${i.available}</td>
              <td style="padding: 10px; border: 1px solid #fecaca; text-align: center;">${i.threshold}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #fecaca; font-size: 11px; color: #94a3b8; text-align: center;">
        Please place purchase orders with suppliers to replenish depleted inventory.
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.LOW_STOCK_ALERT,
    recipients: validRecipients,
    subject: `🚨 Urgent: ${lowStockItems.length} Items Below Low Stock Threshold — ${org.companyName}`,
    htmlContent: html,
  });
}

