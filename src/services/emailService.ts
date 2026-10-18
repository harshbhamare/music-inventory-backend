import { EmailReportConfig } from '../models/EmailReportConfig.js';
import { EmailDeliveryLog } from '../models/EmailDeliveryLog.js';
import { Product } from '../models/Product.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { Sale } from '../models/Sale.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { AppSetting } from '../models/AppSetting.js';
import {
  REPORT_TYPES,
  ReportType,
  USAGE_STATUSES,
  ADJUSTMENT_STATUSES,
} from '../config/constants.js';
import { ENV } from '../config/env.js';

export interface SendEmailParams {
  reportType: ReportType;
  recipients: string[];
  subject: string;
  htmlContent: string;
  idempotencyKey?: string;
}

async function getOrgInfo() {
  const setting = await AppSetting.findOne().lean();
  return {
    companyName: setting?.companyName || 'Stereobliss Retail',
    storeName: setting?.storeName || 'Stereobliss Central Store',
    currencySymbol: setting?.currencySymbol || '₹',
    contactEmail: setting?.contactEmail || 'inventory@stereobliss.com',
  };
}

export async function sendNotificationEmail(params: SendEmailParams) {
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

  let status: 'SENT' | 'SIMULATED' | 'FAILED' = 'SIMULATED';
  let errorDetails: string | undefined;
  let providerReference: string | undefined;

  const validRecipients = params.recipients.filter((r) => r && r.trim().includes('@'));

  if (ENV.RESEND_API_KEY && validRecipients.length > 0) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: ENV.EMAIL_FROM || 'inventory@stereobliss.com',
          to: validRecipients,
          subject: params.subject,
          html: params.htmlContent,
        }),
      });

      const data = (await response.json()) as any;
      if (response.ok) {
        status = 'SENT';
        providerReference = data.id;
      } else {
        status = 'FAILED';
        errorDetails = data.message || JSON.stringify(data);
      }
    } catch (err: any) {
      status = 'FAILED';
      errorDetails = err.message;
    }
  } else {
    // Simulated delivery (safe development mode with full database delivery log)
    status = 'SIMULATED';
    providerReference = `sim-${Date.now()}`;
    console.log(
      `[EMAIL_SIMULATED] Subject: "${params.subject}" to [${validRecipients.join(', ')}]`
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

export async function sendDailyStockSummary(recipients?: string[]) {
  const org = await getOrgInfo();
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

  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.DAILY_STOCK_SUMMARY });
  const targetRecipients = recipients && recipients.length > 0 ? recipients : config?.recipients || [org.contactEmail];

  const dateStr = new Date().toLocaleDateString('en-IN', { dateStyle: 'full' });
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px;">${org.companyName}</h2>
        <div style="color: #64748b; font-size: 13px; margin-top: 4px;">${org.storeName} — Daily Stock & Inventory Summary</div>
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
    recipients: targetRecipients,
    subject: `Daily Stock Summary — ${org.companyName} (${dateStr})`,
    htmlContent: html,
  });
}

export async function sendOverdueUsageReminders(recipients?: string[]) {
  const org = await getOrgInfo();
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

  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.OVERDUE_USAGE_REMINDER });
  const targetRecipients = recipients && recipients.length > 0 ? recipients : config?.recipients || [org.contactEmail];

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
    recipients: targetRecipients,
    subject: `⚠️ Alert: ${overdueRecords.length} Overdue Instrument Loans — ${org.companyName}`,
    htmlContent: html,
  });
}

export async function sendWeeklySalesSummary(recipients?: string[]) {
  const org = await getOrgInfo();
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

  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.WEEKLY_SALES_SUMMARY });
  const targetRecipients = recipients && recipients.length > 0 ? recipients : config?.recipients || [org.contactEmail];

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
    recipients: targetRecipients,
    subject: `Weekly Sales Summary: ${org.currencySymbol}${totalRevenue.toLocaleString('en-IN')} — ${org.companyName}`,
    htmlContent: html,
  });
}

export async function sendLowStockAlert(recipients?: string[]) {
  const org = await getOrgInfo();
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

  const config = await EmailReportConfig.findOne({ reportType: REPORT_TYPES.LOW_STOCK_ALERT });
  const targetRecipients = recipients && recipients.length > 0 ? recipients : config?.recipients || [org.contactEmail];

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
    recipients: targetRecipients,
    subject: `🚨 Urgent: ${lowStockItems.length} Items Below Low Stock Threshold — ${org.companyName}`,
    htmlContent: html,
  });
}

