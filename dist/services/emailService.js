import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { REPORT_TYPES, USAGE_STATUSES, } from '../config/constants.js';
import { ENV } from '../config/env.js';
export async function sendNotificationEmail(params) {
    // Check idempotency to prevent duplicate reports
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
    if (ENV.RESEND_API_KEY) {
        try {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: ENV.EMAIL_FROM,
                    to: params.recipients,
                    subject: params.subject,
                    html: params.htmlContent,
                }),
            });
            const data = (await response.json());
            if (response.ok) {
                status = 'SENT';
                providerReference = data.id;
            }
            else {
                status = 'FAILED';
                errorDetails = data.message || JSON.stringify(data);
            }
        }
        catch (err) {
            status = 'FAILED';
            errorDetails = err.message;
        }
    }
    else {
        // Simulated delivery (safe development mode with full database delivery log)
        status = 'SIMULATED';
        providerReference = `sim-${Date.now()}`;
        console.log(`[EMAIL_SIMULATED] Subject: "${params.subject}" to [${params.recipients.join(', ')}]`);
    }
    const log = await EmailDeliveryLog.create({
        reportType: params.reportType,
        recipients: params.recipients,
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
export async function sendDailyStockSummary(recipients) {
    const products = await Product.find({ isActive: true }).lean();
    let totalOnHand = 0;
    let totalAvailable = 0;
    const lowStockItems = [];
    for (const p of products) {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        const avail = Math.max(0, (sq.onHand || 0) - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0));
        totalOnHand += sq.onHand || 0;
        totalAvailable += avail;
        if (avail <= (p.minStockThreshold || 5)) {
            lowStockItems.push({ name: p.name, sku: p.sku, available: avail, threshold: p.minStockThreshold });
        }
    }
    const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY });
    const targetRecipients = recipients || config?.recipients || ['manager@soundstock.io'];
    const dateStr = new Date().toLocaleDateString('en-IN', { dateStyle: 'full' });
    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #b45309; margin-top: 0;">SoundStock — Daily Stock Summary</h2>
      <p style="color: #64748b; font-size: 14px;">Report Date: ${dateStr}</p>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0;">
        <div style="background: #f8fafc; padding: 16px; border-radius: 6px; border-left: 4px solid #b45309;">
          <div style="font-size: 12px; color: #64748b;">TOTAL ON HAND</div>
          <div style="font-size: 24px; font-weight: bold; color: #0f172a;">${totalOnHand} units</div>
        </div>
        <div style="background: #f8fafc; padding: 16px; border-radius: 6px; border-left: 4px solid #10b981;">
          <div style="font-size: 12px; color: #64748b;">AVAILABLE FOR SALE</div>
          <div style="font-size: 24px; font-weight: bold; color: #0f172a;">${totalAvailable} units</div>
        </div>
      </div>

      <h3>Low Stock Alerts (${lowStockItems.length})</h3>
      ${lowStockItems.length === 0
        ? '<p style="color: #10b981;">All products are currently above their minimum safety thresholds.</p>'
        : `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <thead>
                <tr style="background: #f1f5f9; text-align: left;">
                  <th style="padding: 8px; border: 1px solid #e2e8f0;">Product</th>
                  <th style="padding: 8px; border: 1px solid #e2e8f0;">SKU</th>
                  <th style="padding: 8px; border: 1px solid #e2e8f0;">Available</th>
                  <th style="padding: 8px; border: 1px solid #e2e8f0;">Min Alert</th>
                </tr>
              </thead>
              <tbody>
                ${lowStockItems
            .map((i) => `
                  <tr>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${i.name}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${i.sku}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0; color: #dc2626; font-weight: bold;">${i.available}</td>
                    <td style="padding: 8px; border: 1px solid #e2e8f0;">${i.threshold}</td>
                  </tr>`)
            .join('')}
              </tbody>
            </table>`}
    </div>
  `;
    const todayKey = `daily-summary-${new Date().toISOString().slice(0, 10)}`;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY,
        recipients: targetRecipients,
        subject: `SoundStock Daily Stock Summary — ${dateStr}`,
        htmlContent: html,
        idempotencyKey: todayKey,
    });
}
export async function sendOverdueUsageReminders(recipients) {
    const now = new Date();
    const overdueRecords = await InternalUsage.find({
        status: { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED] },
        expectedReturnDate: { $lt: now },
    })
        .populate('items.product', 'name sku')
        .lean();
    if (overdueRecords.length === 0) {
        return null;
    }
    const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER });
    const targetRecipients = recipients || config?.recipients || ['operations@soundstock.io'];
    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #fed7aa; border-radius: 8px;">
      <h2 style="color: #c2410c; margin-top: 0;">⚠️ SoundStock Alert: Overdue Instrument Loan Returns</h2>
      <p style="color: #475569;">There are <strong>${overdueRecords.length}</strong> equipment issues that have passed their scheduled return date:</p>
      
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 15px;">
        <thead>
          <tr style="background: #ffedd5; text-align: left;">
            <th style="padding: 8px; border: 1px solid #fdba74;">Issue Ref</th>
            <th style="padding: 8px; border: 1px solid #fdba74;">Responsible Person</th>
            <th style="padding: 8px; border: 1px solid #fdba74;">Purpose</th>
            <th style="padding: 8px; border: 1px solid #fdba74;">Expected Date</th>
          </tr>
        </thead>
        <tbody>
          ${overdueRecords
        .map((r) => `
            <tr>
              <td style="padding: 8px; border: 1px solid #fed7aa; font-weight: bold;">${r.issueReference}</td>
              <td style="padding: 8px; border: 1px solid #fed7aa;">${r.assignedPerson} (${r.assignedPersonContact || 'No contact'})</td>
              <td style="padding: 8px; border: 1px solid #fed7aa;">${r.purpose}</td>
              <td style="padding: 8px; border: 1px solid #fed7aa; color: #dc2626; font-weight: bold;">${new Date(r.expectedReturnDate).toLocaleDateString()}</td>
            </tr>`)
        .join('')}
        </tbody>
      </table>
    </div>
  `;
    return sendNotificationEmail({
        reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER,
        recipients: targetRecipients,
        subject: `⚠️ Overdue Instrument Notice: ${overdueRecords.length} items awaiting return`,
        htmlContent: html,
    });
}
