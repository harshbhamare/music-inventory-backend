import nodemailer, { Transporter } from 'nodemailer';
import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { Sale } from '../models/Sale.js';
import { AppSetting } from '../models/AppSetting.js';
import {
  REPORT_TYPES,
  ReportType,
  USAGE_STATUSES,
} from '../config/constants.js';
import { ENV } from '../config/env.js';
import { generateTaxInvoicePdf, formatIndianCurrency } from './pdfService.js';
import { getRentalProfitabilityReport } from './reportService.js';

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

export function resetEmailTransporter(): void {
  cachedTransporter = null;
}

export function getEmailTransporter(): Transporter | null {
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
    } catch (err) {
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
    } catch (err) {
      console.error('[EMAIL_INIT_ERROR] Failed to initialize SMTP transporter:', err);
    }
  }

  return null;
}

export function normalizeRecipients(input?: string | string[]): string[] {
  if (!input) return [];
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

async function resolveRecipients(
  provided?: string | string[],
  fallbackReportType?: ReportType
): Promise<string[]> {
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
    // Simulated mode with full audit logging
    status = 'SIMULATED';
    providerReference = `sim-${Date.now()}`;
    console.log(
      `[EMAIL_SIMULATED] Subject: "${params.subject}" to [${validRecipients.join(', ')}] (Add Gmail app password or SMTP in .env for real delivery)`
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
          <span style="color: #64748b;">Purchase Type:</span>
          <strong>${sale.isEmi ? `Customer EMI Plan (${sale.emiTenureMonths || 6} Months)` : 'Direct Purchase'}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Payment Method:</span>
          <strong>${sale.paymentMethod || 'UPI'}</strong>
        </div>
        ${
          sale.isEmi
            ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #059669; font-weight: 600;">Initial Deposit / Down Payment:</span>
          <strong style="color: #059669;">${org.currencySymbol}${formatIndianCurrency(sale.downPayment || 0)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #64748b;">Monthly Installment:</span>
          <strong>${org.currencySymbol}${formatIndianCurrency(sale.monthlyEmiAmount || 0)} / mo</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #e11d48; font-weight: 600;">Outstanding EMI Balance:</span>
          <strong style="color: #e11d48;">${org.currencySymbol}${formatIndianCurrency(sale.totalEmiDue || 0)}</strong>
        </div>`
            : ''
        }
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #64748b;">Payment Status:</span>
          <strong style="color: ${sale.paymentStatus === 'PAID' ? '#10b981' : '#f59e0b'};">${sale.paymentStatus || 'CONFIRMED'}</strong>
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
        ${
          sale.isEmi
            ? `
        <div style="margin-top: 6px; font-size: 13px; color: #059669;">
          <span>Initial Deposit Paid: </span>
          <strong style="margin-left: 6px;">(-) ${org.currencySymbol}${formatIndianCurrency(sale.downPayment || 0)}</strong>
        </div>
        <div style="margin-top: 6px; font-size: 14px; color: #92400e; font-weight: 700;">
          <span>Net EMI Balance Due: </span>
          <span style="font-size: 16px; margin-left: 6px;">${org.currencySymbol}${formatIndianCurrency(sale.totalEmiDue || Math.max(0, sale.grandTotal - (sale.downPayment || 0)))}</span>
        </div>`
            : ''
        }
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
// Interactive & On-Demand Email Report Generators
// -------------------------------------------------------------

export async function sendDailyStockSummary(recipients?: string | string[], notes?: string) {
  const org = await getOrgInfo();
  const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.DAILY_STOCK_SUMMARY);

  if (validRecipients.length === 0) {
    throw new Error('Please specify at least one recipient email address to send this report.');
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
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px; font-size: 12px; color: #92400e;">
               <strong>Admin Note:</strong> ${notes}
             </div>`
          : ''
      }
      
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

export async function sendOverdueUsageReminders(recipients?: string | string[], notes?: string) {
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
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fff7ed; border-left: 4px solid #ea580c; border-radius: 4px; font-size: 12px; color: #9a3412;">
               <strong>Note:</strong> ${notes}
             </div>`
          : ''
      }
      
      ${
        overdueRecords.length === 0
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
          `
      }
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

export async function sendWeeklySalesSummary(recipients?: string | string[], notes?: string) {
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
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 4px; font-size: 12px; color: #166534;">
               <strong>Management Note:</strong> ${notes}
             </div>`
          : ''
      }

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

export async function sendLowStockAlert(recipients?: string | string[], notes?: string) {
  const org = await getOrgInfo();
  const validRecipients = await resolveRecipients(recipients, REPORT_TYPES.LOW_STOCK_ALERT);

  if (validRecipients.length === 0) {
    throw new Error('Please specify at least one recipient email address to send this report.');
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

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #fecaca; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #b91c1c; margin: 0; font-size: 20px;">🚨 Low Stock &amp; Reorder Level Report</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.companyName} — Inventory Safety Thresholds</div>
      </div>
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; font-size: 12px; color: #991b1b;">
               <strong>Procurement Note:</strong> ${notes}
             </div>`
          : ''
      }
      
      ${
        lowStockItems.length === 0
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
          `
      }
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

export async function sendValuationReportEmail(recipients?: string | string[], notes?: string) {
  const org = await getOrgInfo();
  const validRecipients = await resolveRecipients(recipients);

  if (validRecipients.length === 0) {
    throw new Error('Please specify at least one recipient email address to send this report.');
  }

  const products = await Product.find({ isActive: true }).populate('category', 'name').lean();
  let totalUnitsOnHand = 0;
  let totalCostValuation = 0;
  let totalRetailValuation = 0;

  const categoryMap = new Map<string, { count: number; costVal: number; retailVal: number }>();

  for (const p of products) {
    const qty = p.stockQuantity?.onHand || 0;
    const cost = p.purchaseCost || 0;
    const price = p.defaultSellingPrice || cost;

    totalUnitsOnHand += qty;
    totalCostValuation += qty * cost;
    totalRetailValuation += qty * price;

    const catName = (p.category as any)?.name || 'Musical Instruments';
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
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #eef2ff; border-left: 4px solid #6366f1; border-radius: 4px; font-size: 12px; color: #3730a3;">
               <strong>Valuation Notes:</strong> ${notes}
             </div>`
          : ''
      }

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
            .map(
              ([cat, data]) => `
            <tr>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${cat}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${data.count}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${data.costVal.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #065f46;">${org.currencySymbol}${data.retailVal.toLocaleString('en-IN')}</td>
            </tr>`
            )
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

export async function sendRentalProfitabilityReportEmail(recipient?: string | string[], notes?: string) {
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
      ${
        notes
          ? `<div style="margin: 12px 0; padding: 10px 14px; background: #f5f3ff; border-left: 4px solid #8b5cf6; border-radius: 4px; font-size: 12px; color: #5b21b6;">
               <strong>Rental Audit Notes:</strong> ${notes}
             </div>`
          : ''
      }

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
            .map(
              (cp) => `
            <tr>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${cp.category}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${cp.rentalsCount}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #047857; font-weight: 700;">${org.currencySymbol}${cp.totalCollected.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${org.currencySymbol}${cp.totalCapex.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #6b21a8;">${org.currencySymbol}${cp.netProfit.toLocaleString('en-IN')}</td>
              <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${cp.roiPercent}%</td>
            </tr>`
            )
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

export async function sendTestEmail(recipient?: string | string[], triggeredBy?: string) {
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

export interface RentalReminderEmailParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  issueReference: string;
  productName: string;
  assetId?: string;
  pendingAmount: number;
  monthlyRent: number;
  dueDate?: Date | string;
  billingMonth?: string;
  daysOverdue?: number;
  customNote?: string;
  sentBy: { name: string; email?: string; role?: string };
}

/**
 * Dispatches an official rent payment reminder email to the rental customer
 */
export async function sendRentalPaymentReminderEmail(params: RentalReminderEmailParams) {
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
  const statusColor = isOverdue ? '#dc2626' : '#d97706';
  const statusBg = isOverdue ? '#fef2f2' : '#fffbeb';
  const statusBorder = isOverdue ? '#fecaca' : '#fde68a';
  const statusLabel = isOverdue ? `OVERDUE (${params.daysOverdue} days)` : 'DUE FOR PAYMENT';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #b45309; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Musical Instrument Rentals</div>
        </div>
        <div style="display: inline-block; padding: 6px 12px; background: ${statusBg}; border: 1px solid ${statusBorder}; border-radius: 20px; font-size: 11px; font-weight: 800; color: ${statusColor}; text-transform: uppercase;">
          ${statusLabel}
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        This is a friendly payment reminder from <strong>${org.storeName}</strong> regarding your rented instrument agreement. Your scheduled rental payment is due for settlement.
      </p>

      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #f1f5f9; padding: 10px 16px; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px;">
          Rental Agreement Details
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0; width: 40%;">Instrument / Item:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #e2e8f0;">
              ${params.productName} ${params.assetId ? `<span style="font-weight: normal; color: #64748b;">(Asset ID: ${params.assetId})</span>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Agreement Ref:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.issueReference}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Billing Period:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.billingMonth || 'Current Rental Cycle'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Payment Due Date:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: ${statusColor}; border-bottom: 1px solid #e2e8f0;">${formattedDue}</td>
          </tr>
          <tr style="background: ${statusBg};">
            <td style="padding: 14px 16px; font-weight: 700; color: #0f172a; font-size: 14px;">Total Amount Due:</td>
            <td style="padding: 14px 16px; font-size: 18px; font-weight: 800; color: ${statusColor};">
              ₹${formatIndianCurrency(params.pendingAmount)}
            </td>
          </tr>
        </table>
      </div>

      ${
        params.customNote
          ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
               <strong>Store Note:</strong> ${params.customNote}
             </div>`
          : ''
      }

      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; margin: 20px 0;">
        <h4 style="margin: 0 0 8px 0; color: #1e40af; font-size: 13px; font-weight: 700; text-transform: uppercase;">
          Payment Methods
        </h4>
        <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #1e3a8a; line-height: 1.6;">
          <li><strong>UPI:</strong> Please pay to store UPI ID or scan QR code at the counter.</li>
          <li><strong>Store Counter:</strong> Cash, Debit/Credit Card or NetBanking accepted at ${org.storeName}.</li>
          <li>After payment, kindly share your transaction reference for receipt generation.</li>
        </ul>
      </div>

      <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
        <em>Note: If you have already completed this payment recently, please accept our thanks and disregard this reminder, or reply to this email with your transaction reference.</em>
      </p>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between;">
        <div>Dispatched by: <strong>${params.sentBy.name}</strong> (${params.sentBy.role || 'Management'})</div>
        <div>Contact: <a href="mailto:${org.contactEmail}" style="color: #f59e0b; text-decoration: none;">${org.contactEmail}</a></div>
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.RENTAL_PAYMENT_REMINDER,
    recipients: validRecipients,
    subject: `Payment Reminder: ₹${formatIndianCurrency(params.pendingAmount)} due for ${params.productName} (${params.issueReference})`,
    htmlContent: html,
  });
}

export interface RentalPaymentReceiptParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  issueReference: string;
  productName: string;
  assetId?: string;
  amountPaid: number;
  amountDue: number;
  paymentMethod: string;
  transactionRef?: string;
  billingMonth: string;
  paidAt: Date | string;
  totalRentPaid: number;
  totalRentDue: number;
  nextDueDate?: Date | string;
  recordedBy: { name: string; email?: string; role?: string };
  notes?: string;
}

/**
 * Dispatches an official payment confirmation and receipt email after rent payment is recorded
 */
export async function sendRentalPaymentReceiptEmail(params: RentalPaymentReceiptParams) {
  const org = await getOrgInfo();
  const validRecipients = normalizeRecipients(params.recipientEmail);

  if (validRecipients.length === 0) {
    console.warn(`[EMAIL] Skipping payment receipt email: invalid recipient "${params.recipientEmail}"`);
    return null;
  }

  // Also include store contact email so management has full record/accountability
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
    : 'All Scheduled Dues Clear';

  const receiptRef = params.transactionRef || `RCPT-${Date.now().toString().slice(-6)}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #cbd5e1; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #047857; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Payment Receipt</div>
        </div>
        <div style="display: inline-block; padding: 6px 14px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 20px; font-size: 12px; font-weight: 800; color: #047857; text-transform: uppercase;">
          PAID &amp; CONFIRMED &#10003;
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        Thank you! We have successfully recorded your rental payment for <strong>${params.productName}</strong>. Here is your official payment receipt and updated agreement ledger:
      </p>

      <!-- Receipt Box -->
      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #ecfdf5; border-bottom: 1px solid #d1fae5; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 12px; font-weight: 700; color: #065f46; text-transform: uppercase;">Receipt / Transaction Summary</span>
          <span style="font-size: 12px; font-weight: 700; color: #047857;">Ref: ${receiptRef}</span>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0; width: 42%;">Amount Paid:</td>
            <td style="padding: 12px 16px; font-size: 18px; font-weight: 800; color: #047857; border-bottom: 1px solid #e2e8f0;">
              ₹${formatIndianCurrency(params.amountPaid)}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Payment Mode:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.paymentMethod || 'UPI'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Transaction Ref:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.transactionRef || 'Counter Payment'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Date &amp; Time Paid:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${formattedPaidAt}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Covering Period / Month:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.billingMonth}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Instrument Rented:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">
              ${params.productName} ${params.assetId ? `<span style="font-weight: normal; color: #64748b;">(${params.assetId})</span>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Rental Ref:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.issueReference}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Total Rent Paid to Date:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: #047857; border-bottom: 1px solid #e2e8f0;">₹${formatIndianCurrency(params.totalRentPaid)}</td>
          </tr>
          <tr style="background: ${params.totalRentDue > 0 ? '#fffbeb' : '#f0fdf4'};">
            <td style="padding: 12px 16px; color: #64748b; font-weight: 600;">Remaining Balance Due:</td>
            <td style="padding: 12px 16px; font-weight: 800; color: ${params.totalRentDue > 0 ? '#b45309' : '#059669'};">
              ₹${formatIndianCurrency(params.totalRentDue)} ${params.totalRentDue === 0 ? '(All Clear)' : ''}
            </td>
          </tr>
          ${
            params.totalRentDue > 0
              ? `<tr>
                  <td style="padding: 10px 16px; color: #64748b; font-size: 12px;">Next Scheduled Due Date:</td>
                  <td style="padding: 10px 16px; font-weight: 600; color: #475569; font-size: 12px;">${nextDueText}</td>
                </tr>`
              : ''
          }
        </table>
      </div>

      <!-- Accountability Box -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 12px; color: #475569;">
        <strong>Accountability Record:</strong> Payment verified &amp; recorded by <strong>${params.recordedBy.name}</strong> (${params.recordedBy.role || 'Staff'}) on ${new Date().toLocaleString('en-IN')}.
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
        Thank you for playing with <strong>${org.companyName}</strong>! For assistance, email <a href="mailto:${org.contactEmail}" style="color: #047857; text-decoration: none;">${org.contactEmail}</a>.
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.RENTAL_PAYMENT_CONFIRMATION,
    recipients: allRecipients,
    subject: `Payment Receipt: ₹${formatIndianCurrency(params.amountPaid)} received for ${params.productName} (${params.issueReference})`,
    htmlContent: html,
  });
}

/**
 * High-level router to dispatch any report type by recipient email
 */
export async function dispatchReportEmail(
  reportType: string,
  recipients: string | string[],
  options?: { notes?: string; triggeredBy?: string; customSubject?: string }
) {
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

export interface EmiReminderEmailParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  invoiceNumber: string;
  productName: string;
  pendingAmount: number;
  monthlyEmiAmount: number;
  dueDate?: Date | string;
  billingMonth?: string;
  daysOverdue?: number;
  customNote?: string;
  sentBy: { name: string; email?: string; role?: string };
}

/**
 * Dispatches an official EMI payment reminder email to the customer
 */
export async function sendEmiPaymentReminderEmail(params: EmiReminderEmailParams) {
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
  const statusColor = isOverdue ? '#dc2626' : '#d97706';
  const statusBg = isOverdue ? '#fef2f2' : '#fffbeb';
  const statusBorder = isOverdue ? '#fecaca' : '#fde68a';
  const statusLabel = isOverdue ? `EMI OVERDUE (${params.daysOverdue} days)` : 'EMI PAYMENT DUE';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #b45309; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Retail Purchase EMI Financing</div>
        </div>
        <div style="display: inline-block; padding: 6px 12px; background: ${statusBg}; border: 1px solid ${statusBorder}; border-radius: 20px; font-size: 11px; font-weight: 800; color: ${statusColor}; text-transform: uppercase;">
          ${statusLabel}
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        This is a friendly reminder from <strong>${org.storeName}</strong> regarding your purchase EMI installment under Invoice <strong>${params.invoiceNumber}</strong>. Your scheduled installment payment is due for settlement.
      </p>

      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #f1f5f9; padding: 10px 16px; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px;">
          EMI Financing Agreement Details
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0; width: 40%;">Purchased Item:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #e2e8f0;">
              ${params.productName}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Tax Invoice Number:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Installment Month:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.billingMonth || 'Scheduled Installment'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Installment Due Date:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: ${statusColor}; border-bottom: 1px solid #e2e8f0;">${formattedDue}</td>
          </tr>
          <tr style="background: ${statusBg};">
            <td style="padding: 14px 16px; font-weight: 700; color: #0f172a; font-size: 14px;">Total Pending Due:</td>
            <td style="padding: 14px 16px; font-size: 18px; font-weight: 800; color: ${statusColor};">
              ₹${formatIndianCurrency(params.pendingAmount)}
            </td>
          </tr>
        </table>
      </div>

      ${
        params.customNote
          ? `<div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
               <strong>Store Note:</strong> ${params.customNote}
             </div>`
          : ''
      }

      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; margin: 20px 0;">
        <h4 style="margin: 0 0 8px 0; color: #1e40af; font-size: 13px; font-weight: 700; text-transform: uppercase;">
          Payment Methods
        </h4>
        <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #1e3a8a; line-height: 1.6;">
          <li><strong>UPI:</strong> GPay / PhonePe / Paytm to store counter or scan QR code.</li>
          <li><strong>Store Counter:</strong> Cash, Credit/Debit Card, NetBanking at ${org.storeName}.</li>
          <li>After payment, kindly share transaction reference for instant receipt generation.</li>
        </ul>
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between;">
        <div>Dispatched by: <strong>${params.sentBy.name}</strong> (${params.sentBy.role || 'Management'})</div>
        <div>Contact: <a href="mailto:${org.contactEmail}" style="color: #f59e0b; text-decoration: none;">${org.contactEmail}</a></div>
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.EMI_PAYMENT_REMINDER,
    recipients: validRecipients,
    subject: `EMI Payment Reminder: ₹${formatIndianCurrency(params.pendingAmount)} due for ${params.productName} (${params.invoiceNumber})`,
    htmlContent: html,
  });
}

export interface EmiPaymentReceiptParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  invoiceNumber: string;
  productName: string;
  amountPaid: number;
  amountDue: number;
  paymentMethod: string;
  transactionRef?: string;
  billingMonth: string;
  paidAt: Date | string;
  totalEmiPaid: number;
  totalEmiDue: number;
  nextDueDate?: Date | string;
  recordedBy: { name: string; email?: string; role?: string };
  notes?: string;
}

/**
 * Dispatches an official payment confirmation and receipt email after an EMI payment is recorded
 */
export async function sendEmiPaymentReceiptEmail(params: EmiPaymentReceiptParams) {
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

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #10b981; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #065f46; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; EMI Payment Confirmation Receipt</div>
        </div>
        <div style="display: inline-block; padding: 6px 14px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 20px; font-size: 11px; font-weight: 800; color: #047857; text-transform: uppercase;">
          RECEIPT VERIFIED
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        We have received and recorded your scheduled EMI installment payment of <strong>₹${formatIndianCurrency(params.amountPaid)}</strong> for Invoice <strong>${params.invoiceNumber}</strong>. Here are the official receipt details:
      </p>

      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr style="background: #f0fdf4;">
            <td style="padding: 12px 16px; font-weight: 700; color: #065f46; border-bottom: 1px solid #bbf7d0;">Installment Amount Received:</td>
            <td style="padding: 12px 16px; font-size: 18px; font-weight: 800; color: #047857; border-bottom: 1px solid #bbf7d0;">
              ₹${formatIndianCurrency(params.amountPaid)}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Payment Mode:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.paymentMethod}</td>
          </tr>
          ${
            params.transactionRef
              ? `<tr>
                  <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Transaction Ref:</td>
                  <td style="padding: 12px 16px; font-family: monospace; font-weight: 700; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${params.transactionRef}</td>
                </tr>`
              : ''
          }
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Date Received:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${formattedPaidAt}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Covering Installment:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.billingMonth}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Purchased Item:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">
              ${params.productName}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Invoice Ref:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Total EMI Paid to Date:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: #047857; border-bottom: 1px solid #e2e8f0;">₹${formatIndianCurrency(params.totalEmiPaid)}</td>
          </tr>
          <tr style="background: ${params.totalEmiDue > 0 ? '#fffbeb' : '#f0fdf4'};">
            <td style="padding: 12px 16px; color: #64748b; font-weight: 600;">Remaining Balance Due:</td>
            <td style="padding: 12px 16px; font-weight: 800; color: ${params.totalEmiDue > 0 ? '#b45309' : '#059669'};">
              ₹${formatIndianCurrency(params.totalEmiDue)} ${params.totalEmiDue === 0 ? '(All Clear - Paid in Full!)' : ''}
            </td>
          </tr>
          ${
            params.totalEmiDue > 0
              ? `<tr>
                  <td style="padding: 10px 16px; color: #64748b; font-size: 12px;">Next Scheduled EMI Due Date:</td>
                  <td style="padding: 10px 16px; font-weight: 600; color: #475569; font-size: 12px;">${nextDueText}</td>
                </tr>`
              : ''
          }
        </table>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 12px; color: #475569;">
        <strong>Accountability Record:</strong> Payment verified &amp; recorded by <strong>${params.recordedBy.name}</strong> (${params.recordedBy.role || 'Staff'}) on ${new Date().toLocaleString('en-IN')}.
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
        Thank you for choosing <strong>${org.companyName}</strong>! For assistance, email <a href="mailto:${org.contactEmail}" style="color: #047857; text-decoration: none;">${org.contactEmail}</a>.
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.EMI_PAYMENT_RECEIPT,
    recipients: allRecipients,
    subject: `EMI Payment Receipt: ₹${formatIndianCurrency(params.amountPaid)} received for ${params.productName} (${params.invoiceNumber})`,
    htmlContent: html,
  });
}


export interface DepositDeductionNoticeParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  issueReference: string;
  productName: string;
  assetId?: string;
  billingMonth: string;
  deductedAmount: number;
  depositBalanceBefore: number;
  depositBalanceAfter: number;
  depositExhausted: boolean;
  deductedAt: Date | string;
  sentBy: { name: string; email?: string; role?: string };
  notes?: string;
}

/**
 * Sends an official rent-deduction notice to the customer when monthly rent is subtracted from deposit.
 * Triggered by manager/admin clicking "Send Notice Email" from the notification bell.
 */
export async function sendDepositDeductionNoticeEmail(params: DepositDeductionNoticeParams) {
  const org = await getOrgInfo();
  const validRecipients = normalizeRecipients(params.recipientEmail);

  if (validRecipients.length === 0) {
    throw new Error(`Invalid recipient email for deposit deduction notice: "${params.recipientEmail}"`);
  }

  // Always CC the store email for accountability
  const storeRecipients = normalizeRecipients(org.contactEmail);
  const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));

  const formattedDate = new Date(params.deductedAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const balanceColor = params.depositBalanceAfter <= 0 ? '#dc2626' : params.depositBalanceAfter < params.deductedAmount * 2 ? '#d97706' : '#047857';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #cbd5e1; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #6366f1; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #4338ca; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Rental Deposit Statement</div>
        </div>
        <div style="display: inline-block; padding: 6px 14px; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 20px; font-size: 11px; font-weight: 800; color: #4338ca; text-transform: uppercase;">
          DEPOSIT DEDUCTION
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>

      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        This is to inform you that your monthly rental payment for <strong>${params.billingMonth}</strong> has been automatically deducted from your security deposit on file. No separate payment action is required from your end for this period.
      </p>

      <!-- Deduction Summary Table -->
      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #eef2ff; border-bottom: 1px solid #c7d2fe; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 12px; font-weight: 700; color: #3730a3; text-transform: uppercase;">Deposit Deduction Statement</span>
          <span style="font-size: 12px; font-weight: 700; color: #4338ca;">${formattedDate}</span>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0; width: 45%;">Instrument Rented:</td>
            <td style="padding: 12px 16px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #e2e8f0;">
              ${params.productName}${params.assetId ? ` <span style="font-weight: normal; color: #64748b;">(${params.assetId})</span>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Agreement Reference:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.issueReference}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Billing Period:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">${params.billingMonth}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Deposit Balance Before:</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #334155; border-bottom: 1px solid #e2e8f0;">₹${formatIndianCurrency(params.depositBalanceBefore)}</td>
          </tr>
          <tr style="background: #fef3c7;">
            <td style="padding: 13px 16px; font-weight: 700; color: #92400e; border-bottom: 1px solid #fde68a;">Rent Deducted This Month:</td>
            <td style="padding: 13px 16px; font-size: 17px; font-weight: 800; color: #b45309; border-bottom: 1px solid #fde68a;">
              − ₹${formatIndianCurrency(params.deductedAmount)}
            </td>
          </tr>
          <tr style="background: ${params.depositBalanceAfter <= 0 ? '#fef2f2' : '#f0fdf4'};">
            <td style="padding: 13px 16px; font-weight: 700; color: #0f172a;">Remaining Deposit Balance:</td>
            <td style="padding: 13px 16px; font-size: 17px; font-weight: 800; color: ${balanceColor};">
              ₹${formatIndianCurrency(params.depositBalanceAfter)}${params.depositBalanceAfter <= 0 ? ' (Fully Utilised)' : ''}
            </td>
          </tr>
        </table>
      </div>

      ${params.depositExhausted ? `
      <div style="margin: 16px 0; padding: 14px 16px; background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; font-size: 13px; color: #991b1b;">
        <strong>⚠ Deposit Fully Utilised — Continuation Notice</strong><br/>
        <span style="display: block; margin-top: 6px; color: #7f1d1d; line-height: 1.5;">
          Your security deposit has been fully utilised for rental payments. To continue renting, monthly rent payments will now need to be made directly. Our team will reach out to discuss continuation terms. Please contact us at 
          <a href="mailto:${org.contactEmail}" style="color: #dc2626;">${org.contactEmail}</a>.
        </span>
      </div>
      ` : ''}

      ${params.notes ? `
      <div style="margin: 16px 0; padding: 12px 16px; background: #fefce8; border-left: 4px solid #eab308; border-radius: 6px; font-size: 13px; color: #854d0e;">
        <strong>Note from Store:</strong> ${params.notes}
      </div>
      ` : ''}

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 12px; color: #475569;">
        <strong>Accountability Record:</strong> This deduction was processed by <strong>${params.sentBy.name}</strong> (${params.sentBy.role || 'Management'}) on ${formattedDate}.
        If you have any questions about this statement, please contact us directly at <a href="mailto:${org.contactEmail}" style="color: #4338ca;">${org.contactEmail}</a>.
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
        Thank you for renting with <strong>${org.companyName}</strong>!
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.RENTAL_DEPOSIT_DEDUCTION_NOTICE as any,
    recipients: allRecipients,
    subject: `Rent Deducted from Deposit — ${params.billingMonth} | ${params.productName} (${params.issueReference})`,
    htmlContent: html,
  });
}

export interface RentalAgreementWelcomeParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  issueReference: string;
  productName: string;
  monthlyRent: number;
  securityDeposit: number;
  depositTransactionRef: string;
  depositMode: boolean;
  lockInPeriodMonths: number;
  expectedReturnDate: string;
  includedAccessories: string[];
}

/**
 * Sends a welcome / agreement confirmation email to the customer when a rental is created.
 * Summarises instrument, terms, deposit, and monthly rent details.
 */
export async function sendRentalAgreementWelcomeEmail(params: RentalAgreementWelcomeParams) {
  const org = await getOrgInfo();
  const validRecipients = normalizeRecipients(params.recipientEmail);

  if (validRecipients.length === 0) {
    console.warn(`[EMAIL] Skipping rental welcome email: invalid recipient "${params.recipientEmail}"`);
    return null;
  }

  const storeRecipients = normalizeRecipients(org.contactEmail);
  const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));

  const returnDate = new Date(params.expectedReturnDate).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  const totalDeposit = formatIndianCurrency(params.securityDeposit);
  const monthlyRent  = formatIndianCurrency(params.monthlyRent);

  const depositModeNote = params.depositMode
    ? `Your security deposit of ₹${totalDeposit} will be utilised as monthly rent payments (₹${monthlyRent}/mo). No separate monthly payment is required during the lock-in period.`
    : `Your monthly rent of ₹${monthlyRent} is payable at the start of each month. A receipt will be emailed upon each payment.`;

  const accessoriesHtml = params.includedAccessories.length > 0
    ? params.includedAccessories.map(a => `<li style="padding: 2px 0;">${a}</li>`).join('')
    : '<li>No bundled accessories</li>';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #cbd5e1; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 16px; margin-bottom: 20px;">
        <h2 style="color: #b45309; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Rental Agreement Confirmation</div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>
      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        Thank you for renting with <strong>${org.storeName}</strong>! Your rental agreement has been confirmed. Here are your full agreement details for reference:
      </p>

      <div style="margin: 20px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: #fefce8; border-bottom: 1px solid #fde68a; padding: 10px 16px; font-size: 12px; font-weight: 700; color: #92400e; text-transform: uppercase; letter-spacing: 0.5px;">
          Agreement Summary — ${params.issueReference}
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9; width: 45%;">Instrument Rented:</td><td style="padding: 10px 16px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${params.productName}</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Agreement Reference:</td><td style="padding: 10px 16px; font-weight: 600; border-bottom: 1px solid #f1f5f9;">${params.issueReference}</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Lock-In Period:</td><td style="padding: 10px 16px; font-weight: 600; border-bottom: 1px solid #f1f5f9;">${params.lockInPeriodMonths} Month${params.lockInPeriodMonths > 1 ? 's' : ''}</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Agreement End Date:</td><td style="padding: 10px 16px; font-weight: 600; color: #b45309; border-bottom: 1px solid #f1f5f9;">${returnDate}</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Monthly Rent:</td><td style="padding: 10px 16px; font-weight: 700; color: #d97706; border-bottom: 1px solid #f1f5f9;">₹${monthlyRent} / month</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Security Deposit:</td><td style="padding: 10px 16px; font-weight: 700; color: #4f46e5; border-bottom: 1px solid #f1f5f9;">₹${totalDeposit} (Txn: ${params.depositTransactionRef || 'N/A'})</td></tr>
          <tr><td style="padding: 10px 16px; color: #64748b;">Payment Mode:</td><td style="padding: 10px 16px; font-weight: 600;">${params.depositMode ? 'Deposit-as-Rent (auto-deducted monthly)' : 'Direct Monthly Payment'}</td></tr>
        </table>
      </div>

      <div style="margin: 16px 0; padding: 14px 16px; background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 8px; font-size: 13px; color: #78350f;">
        <strong>Payment Terms:</strong><br/>
        <span style="display: block; margin-top: 6px; line-height: 1.5;">${depositModeNote}</span>
      </div>

      ${params.includedAccessories.length > 0 ? `
      <div style="margin: 16px 0;">
        <div style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Bundled Accessories Included</div>
        <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #334155; line-height: 1.6;">${accessoriesHtml}</ul>
      </div>
      ` : ''}

      <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
        For any queries, please contact us at <a href="mailto:${org.contactEmail}" style="color: #f59e0b;">${org.contactEmail}</a>.
      </p>

      <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
        Thank you for choosing <strong>${org.companyName}</strong>. Happy playing!
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.RENTAL_PAYMENT_REMINDER as any,
    recipients: allRecipients,
    subject: `Rental Agreement Confirmed — ${params.productName} | ${params.issueReference}`,
    htmlContent: html,
  });
}

export interface DepositExhaustionParams {
  recipientEmail: string;
  customerName: string;
  customerContact?: string;
  issueReference: string;
  productName: string;
  monthlyRent: number;
  lastBillingMonth: string;
  sentBy: { name: string; email?: string; role?: string };
}

/**
 * Sends a notice to the customer when their security deposit has been fully exhausted.
 * Informs them that direct monthly rent payments are now required for continuation.
 */
export async function sendDepositExhaustionEmail(params: DepositExhaustionParams) {
  const org = await getOrgInfo();
  const validRecipients = normalizeRecipients(params.recipientEmail);

  if (validRecipients.length === 0) {
    console.warn(`[EMAIL] Skipping deposit exhaustion email: invalid recipient "${params.recipientEmail}"`);
    return null;
  }

  const storeRecipients = normalizeRecipients(org.contactEmail);
  const allRecipients = Array.from(new Set([...validRecipients, ...storeRecipients]));

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: auto; padding: 28px; border: 1px solid #fecaca; border-radius: 14px; background: #ffffff; color: #1e293b;">
      <div style="border-bottom: 2px solid #dc2626; padding-bottom: 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <h2 style="color: #b91c1c; margin: 0; font-size: 22px; font-weight: 700;">${org.companyName}</h2>
          <div style="color: #64748b; font-size: 13px; margin-top: 3px;">${org.storeName} &bull; Deposit Exhaustion Notice</div>
        </div>
        <div style="display: inline-block; padding: 6px 14px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 20px; font-size: 11px; font-weight: 800; color: #dc2626; text-transform: uppercase;">
          ACTION REQUIRED
        </div>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
        Dear <strong>${params.customerName}</strong>,
      </p>
      <p style="font-size: 14px; line-height: 1.6; color: #334155;">
        Your security deposit for the rental of <strong>${params.productName}</strong> (Ref: <strong>${params.issueReference}</strong>) has been <strong style="color: #dc2626;">fully utilised</strong> as of <strong>${params.lastBillingMonth}</strong>.
      </p>

      <div style="margin: 20px 0; padding: 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; font-size: 13px; color: #991b1b;">
        <strong>What this means:</strong>
        <ul style="margin: 8px 0 0 0; padding-left: 20px; line-height: 1.8;">
          <li>Your deposit of has been fully applied to your monthly rent payments.</li>
          <li>To continue renting, you must now pay <strong>₹${formatIndianCurrency(params.monthlyRent)} per month</strong> directly.</li>
          <li>Please visit the store or contact us to arrange your next payment before the upcoming due date.</li>
        </ul>
      </div>

      <div style="margin: 16px 0; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; font-size: 13px; color: #1e40af;">
        <strong>To Continue Your Rental:</strong>
        <ul style="margin: 8px 0 0 0; padding-left: 18px; line-height: 1.6;">
          <li><strong>UPI / Store counter</strong> — Pay ₹${formatIndianCurrency(params.monthlyRent)} and share the transaction reference for receipt generation.</li>
          <li>Contact: <a href="mailto:${org.contactEmail}" style="color: #1d4ed8;">${org.contactEmail}</a></li>
        </ul>
      </div>

      <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between;">
        <div>Sent by: <strong>${params.sentBy.name}</strong> (${params.sentBy.role || 'Management'})</div>
        <div><a href="mailto:${org.contactEmail}" style="color: #f59e0b; text-decoration: none;">${org.contactEmail}</a></div>
      </div>
    </div>
  `;

  return sendNotificationEmail({
    reportType: REPORT_TYPES.RENTAL_DEPOSIT_DEDUCTION_NOTICE as any,
    recipients: allRecipients,
    subject: `Deposit Fully Utilised — Continuation Rent Required | ${params.issueReference}`,
    htmlContent: html,
  });
}
