import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { AppSetting } from '../models/AppSetting.js';

// Convert number to Indian currency words
export function numberToIndianWords(num: number): string {
  if (num === 0) return 'INR Zero Only';

  const a = [
    '',
    'One ',
    'Two ',
    'Three ',
    'Four ',
    'Five ',
    'Six ',
    'Seven ',
    'Eight ',
    'Nine ',
    'Ten ',
    'Eleven ',
    'Twelve ',
    'Thirteen ',
    'Fourteen ',
    'Fifteen ',
    'Sixteen ',
    'Seventeen ',
    'Eighteen ',
    'Nineteen ',
  ];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const inWords = (n: number): string => {
    let str = '';
    if (n > 19) {
      str += b[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + a[n % 10] : ' ');
    } else {
      str += a[n];
    }
    return str;
  };

  const whole = Math.floor(num);
  const fraction = Math.round((num - whole) * 100);

  let n = whole;
  let result = '';

  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  if (crore > 0) result += inWords(crore) + 'Crore ';

  const lakh = Math.floor(n / 100000);
  n %= 100000;
  if (lakh > 0) result += inWords(lakh) + 'Lakh ';

  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (thousand > 0) result += inWords(thousand) + 'Thousand ';

  const hundred = Math.floor(n / 100);
  n %= 100;
  if (hundred > 0) result += inWords(hundred) + 'Hundred ';

  if (n > 0) {
    if (result !== '') result += 'and ';
    result += inWords(n);
  }

  let finalWords = 'INR ' + result.trim();
  if (fraction > 0) {
    finalWords += ' and ' + inWords(fraction).trim() + ' Paise';
  }
  return finalWords + ' Only';
}

export function formatIndianCurrency(num: number): string {
  return Number(num || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

import { fileURLToPath } from 'url';

const currentServiceDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the invoice template image strictly within the backend repository
 */
function resolveTemplateImagePath(): string | null {
  const candidatePaths = [
    // Relative to this service file (works in dev and production dist)
    path.resolve(currentServiceDir, '../assets/templates/invoice_template.png'),
    path.resolve(currentServiceDir, '../../assets/templates/invoice_template.png'),
    // Relative to cwd when executed from backend root
    path.resolve(process.cwd(), 'src/assets/templates/invoice_template.png'),
    path.resolve(process.cwd(), 'assets/templates/invoice_template.png'),
    path.resolve(process.cwd(), 'dist/assets/templates/invoice_template.png'),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Returns fonts that support high-resolution rendering and ₹ currency glyphs
 */
function resolveSystemFonts() {
  const segoeRegular = 'C:/Windows/Fonts/segoeui.ttf';
  const segoeBold = 'C:/Windows/Fonts/segoeuib.ttf';
  const segoeSemiBold = 'C:/Windows/Fonts/seguisb.ttf';

  const arialRegular = 'C:/Windows/Fonts/arial.ttf';
  const arialBold = 'C:/Windows/Fonts/arialbd.ttf';

  if (fs.existsSync(segoeRegular) && fs.existsSync(segoeBold)) {
    return {
      regular: segoeRegular,
      bold: segoeBold,
      semiBold: fs.existsSync(segoeSemiBold) ? segoeSemiBold : segoeBold,
      symbolPrefix: '₹',
    };
  }

  if (fs.existsSync(arialRegular) && fs.existsSync(arialBold)) {
    return {
      regular: arialRegular,
      bold: arialBold,
      semiBold: arialBold,
      symbolPrefix: '₹',
    };
  }

  return {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    semiBold: 'Helvetica-Bold',
    symbolPrefix: '₹',
  };
}

export async function generateTaxInvoicePdf(sale: any): Promise<Buffer> {
  let setting: any = null;
  try {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      setting = await AppSetting.findOne().lean();
    }
  } catch {
    setting = null;
  }

  // Canonical Stereobliss information as in reference_invoice.jpg
  const companyName = setting?.companyName || 'STEREOBLISS';
  const addressLine1 = '2nd Floor, Radhika Avenue, Wakad- Nasik Road';
  const addressLine2 = 'Next to Copa Vila';
  const contactPhone = setting?.contactPhone || '9960540161';
  const contactEmail = setting?.contactEmail || 'harsh.bagle@muziclub.com';
  const website = 'www.muziclub.com';
  const gstin = setting?.gstin || '27ADDFS8850Q1Z6';

  const invoiceNo = sale.invoiceNumber || 'INV0058';
  const invoiceDate = new Date(sale.createdAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateFormatted = `${pad(invoiceDate.getDate())}/${pad(invoiceDate.getMonth() + 1)}/${invoiceDate.getFullYear()}`;

  const buyerName = sale.customerName || 'Customer';
  const buyerPhone = sale.customerPhone || '';
  const buyerEmail = sale.customerEmail || '';
  const paymentMethod = sale.paymentMethod || 'Gpay';

  const templatePath = resolveTemplateImagePath();
  const fonts = resolveSystemFonts();

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Tax Invoice - ${invoiceNo}`,
          Author: companyName,
          Subject: 'Tax Invoice',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const leftMargin = 40;
      const rightMargin = 555;
      const contentWidth = rightMargin - leftMargin; // 515 pt

      // 1. Draw Blank Template Background (Contains Stereobliss logo top-left and red notes circle bottom-right)
      if (templatePath) {
        doc.image(templatePath, 0, 0, { width: pageWidth, height: pageHeight });
      }

      // 2. Company Contact Details Header (Top-Right)
      const headerRightX = 350;
      let headerY = 50;
      doc.font(fonts.bold).fontSize(10.5).fillColor('#000000').text(companyName.toUpperCase(), headerRightX, headerY);
      headerY += 13;

      doc.font(fonts.regular).fontSize(7.5).fillColor('#334155');
      doc.text(addressLine1, headerRightX, headerY);
      headerY += 10.5;
      doc.text(addressLine2, headerRightX, headerY);
      headerY += 10.5;
      doc.text(contactPhone, headerRightX, headerY);
      headerY += 10.5;
      doc.text(contactEmail, headerRightX, headerY);
      headerY += 10.5;
      doc.text(website, headerRightX, headerY);
      headerY += 10.5;
      doc.text(`GSTIN : ${gstin}`, headerRightX, headerY);

      // 3. Thin Horizontal Line below Header
      const headerDividerY = 136;
      doc.moveTo(leftMargin, headerDividerY).lineTo(rightMargin, headerDividerY).lineWidth(0.6).stroke('#cbd5e1');

      // 4. BILL TO (Left) & INVOICE Details (Right)
      const detailsTopY = 148;

      // Left side: BILL TO
      doc.font(fonts.bold).fontSize(8).fillColor('#64748b').text('BILL TO', leftMargin, detailsTopY);
      doc.font(fonts.bold).fontSize(12).fillColor('#0f172a').text(buyerName, leftMargin, detailsTopY + 12);
      let buyerMetaY = detailsTopY + 28;
      if (buyerPhone) {
        doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(buyerPhone, leftMargin, buyerMetaY);
        buyerMetaY += 11;
      }
      if (buyerEmail) {
        doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(buyerEmail, leftMargin, buyerMetaY);
      }

      // Right side: INVOICE details with vertical blue accent bar
      const invoiceBlockX = 350;
      // Vertical accent line
      doc.moveTo(invoiceBlockX, detailsTopY).lineTo(invoiceBlockX, detailsTopY + 45).lineWidth(2.5).stroke('#0077c5');

      const invoiceTextX = invoiceBlockX + 10;
      doc.font(fonts.bold).fontSize(17).fillColor('#0077c5').text('INVOICE', invoiceTextX, detailsTopY - 2);

      const metaRow1Y = detailsTopY + 24;
      doc.font(fonts.bold).fontSize(8.5).fillColor('#0f172a').text('Invoice No.', invoiceTextX, metaRow1Y);
      doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(invoiceNo, invoiceTextX + 75, metaRow1Y);

      const metaRow2Y = metaRow1Y + 12.5;
      doc.font(fonts.bold).fontSize(8.5).fillColor('#0f172a').text('Invoice Date', invoiceTextX, metaRow2Y);
      doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(dateFormatted, invoiceTextX + 75, metaRow2Y);

      // 5. Line Items Table
      const tableTopY = 215;
      const headerHeight = 22;

      // Column definitions matching reference_invoice.jpg exact layout
      const cols = {
        sl: { x: leftMargin, w: 32 },
        desc: { x: leftMargin + 32, w: 205 },
        hsn: { x: leftMargin + 32 + 205, w: 68 },
        qty: { x: leftMargin + 32 + 205 + 68, w: 48 },
        price: { x: leftMargin + 32 + 205 + 68 + 48, w: 76 },
        amount: { x: leftMargin + 32 + 205 + 68 + 48 + 76, w: 86 },
      };

      // Header background rectangle (#1a6eb7 royal blue)
      doc.rect(leftMargin, tableTopY, contentWidth, headerHeight).fill('#1a6eb7');

      // Header titles (white, bold)
      doc.font(fonts.bold).fontSize(8.5).fillColor('#ffffff');
      doc.text('#', cols.sl.x, tableTopY + 6, { width: cols.sl.w, align: 'center' });
      doc.text('Description', cols.desc.x + 8, tableTopY + 6, { width: cols.desc.w - 12, align: 'left' });
      doc.text('HSN/SAC', cols.hsn.x, tableTopY + 6, { width: cols.hsn.w, align: 'center' });
      doc.text('Qty', cols.qty.x, tableTopY + 6, { width: cols.qty.w, align: 'center' });
      doc.text(`Price (${fonts.symbolPrefix})`, cols.price.x, tableTopY + 6, { width: cols.price.w - 8, align: 'right' });
      doc.text(`Amount (${fonts.symbolPrefix})`, cols.amount.x, tableTopY + 6, { width: cols.amount.w - 8, align: 'right' });

      // Subtle column dividing lines in header
      const vLineXs = [cols.desc.x, cols.hsn.x, cols.qty.x, cols.price.x, cols.amount.x];
      vLineXs.forEach((x) => {
        doc.moveTo(x, tableTopY).lineTo(x, tableTopY + headerHeight).lineWidth(0.5).stroke('#3b82f6');
      });

      // Data Rows
      let currentY = tableTopY + headerHeight;
      const lineItems = sale.lineItems || [];

      lineItems.forEach((li: any, index: number) => {
        const prodName = li.product?.name || 'Instrument / Musical Accessory';
        const brand = li.product?.brand ? ` ${li.product.brand}` : '';
        const color = li.product?.color ? ` (${li.product.color})` : '';
        const hsn = li.hsnCode || (li.product as any)?.hsnCode || '92029000';
        const qty = li.quantity || 1;
        const unitPrice = li.unitPrice || 0;
        const totalAmount = li.total || (qty * unitPrice);

        const hasSerials = li.serializedItemIds && li.serializedItemIds.length > 0;
        const rowHeight = hasSerials ? 42 : 36;

        // Row background
        doc.rect(leftMargin, currentY, contentWidth, rowHeight).fill('#ffffff');

        // Draw vertical cell border lines in light gray
        doc.rect(leftMargin, currentY, contentWidth, rowHeight).lineWidth(0.5).stroke('#e2e8f0');
        vLineXs.forEach((x) => {
          doc.moveTo(x, currentY).lineTo(x, currentY + rowHeight).lineWidth(0.5).stroke('#e2e8f0');
        });

        // 1. Sl No
        doc.font(fonts.regular).fontSize(8.5).fillColor('#0f172a');
        doc.text(String(index + 1), cols.sl.x, currentY + 9, { width: cols.sl.w, align: 'center' });

        // 2. Description (Bold title + HSN subtitle in light gray)
        doc.font(fonts.bold).fontSize(8.5).fillColor('#0f172a');
        doc.text(`${prodName}${brand}${color}`, cols.desc.x + 8, currentY + 7, { width: cols.desc.w - 12 });

        let subLine = `HSN/SAC- ${hsn}`;
        if (hasSerials) {
          const serials = li.serializedItemIds.map((s: any) => s.assetId || s.manufacturerSerial || s).join(', ');
          subLine += ` | SN: ${serials}`;
        }
        doc.font(fonts.regular).fontSize(7.5).fillColor('#64748b');
        doc.text(subLine, cols.desc.x + 8, currentY + 20, { width: cols.desc.w - 12 });

        // 3. HSN/SAC
        doc.font(fonts.regular).fontSize(8.5).fillColor('#334155');
        doc.text(hsn, cols.hsn.x, currentY + 11, { width: cols.hsn.w, align: 'center' });

        // 4. Quantity
        doc.font(fonts.regular).fontSize(8.5).fillColor('#334155');
        doc.text(String(qty), cols.qty.x, currentY + 11, { width: cols.qty.w, align: 'center' });

        // 5. Price
        doc.font(fonts.regular).fontSize(8.5).fillColor('#0f172a');
        doc.text(formatIndianCurrency(unitPrice), cols.price.x, currentY + 11, { width: cols.price.w - 8, align: 'right' });

        // 6. Amount
        doc.font(fonts.regular).fontSize(8.5).fillColor('#0f172a');
        doc.text(formatIndianCurrency(totalAmount), cols.amount.x, currentY + 11, { width: cols.amount.w - 8, align: 'right' });

        currentY += rowHeight;
      });

      // 6. Payment Method & Totals Section
      const summaryStartY = currentY + 18;

      // Left: Payment Method
      doc.font(fonts.bold).fontSize(9.5).fillColor('#0f172a').text('Payment Method', leftMargin, summaryStartY);
      doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(paymentMethod, leftMargin, summaryStartY + 14);

      // Right: Totals
      const totalsBoxX = 350;
      const totalsWidth = rightMargin - totalsBoxX;
      let totY = summaryStartY;

      const taxableAmount = sale.taxableAmount || (sale.subtotal - (sale.discountTotal || 0));
      const cgstAmount = sale.cgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;
      const sgstAmount = sale.sgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;
      const grandTotal = sale.grandTotal || (taxableAmount + cgstAmount + sgstAmount);

      const renderTotalLine = (label: string, amount: number) => {
        doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(label, totalsBoxX, totY);
        doc.font(fonts.regular).fontSize(8.5).fillColor('#0f172a').text(
          `${fonts.symbolPrefix}${formatIndianCurrency(amount)}`,
          totalsBoxX,
          totY,
          { width: totalsWidth, align: 'right' }
        );
        totY += 15;
      };

      renderTotalLine('Subtotal', taxableAmount);
      renderTotalLine('CGST (9%)', cgstAmount);
      renderTotalLine('SGST (9%)', sgstAmount);

      // Highlighted TOTAL (INR) Bar
      const totalBarY = totY + 2;
      const totalBarHeight = 26;
      doc.rect(totalsBoxX - 6, totalBarY, totalsWidth + 6, totalBarHeight).fill('#e1f0fa');

      doc.font(fonts.bold).fontSize(9.5).fillColor('#0f172a').text('TOTAL (INR)', totalsBoxX, totalBarY + 7);
      doc.font(fonts.bold).fontSize(10.5).fillColor('#0f172a').text(
        `${fonts.symbolPrefix}${formatIndianCurrency(grandTotal)}`,
        totalsBoxX,
        totalBarY + 6.5,
        { width: totalsWidth, align: 'right' }
      );

      // 7. Divider Line below Totals
      const lowerDividerY = totalBarY + totalBarHeight + 24;
      doc.moveTo(leftMargin, lowerDividerY).lineTo(rightMargin, lowerDividerY).lineWidth(0.6).stroke('#cbd5e1');

      // 8. Terms & Conditions Section
      const termsY = lowerDividerY + 16;
      doc.font(fonts.bold).fontSize(9).fillColor('#0f172a').text('Terms & Conditions', leftMargin, termsY);
      doc.font(fonts.regular).fontSize(8).fillColor('#334155');
      doc.text('3.   Goods remain property of the seller until full payment is received.', leftMargin, termsY + 15);
      doc.text('4.   Prices are inclusive of all applicable taxes.', leftMargin, termsY + 27);

      // 9. Footer Computer Generated Receipt Disclaimer
      const footerDividerY = 776;
      doc.moveTo(leftMargin, footerDividerY).lineTo(rightMargin, footerDividerY).lineWidth(0.6).stroke('#cbd5e1');

      doc.font(fonts.regular).fontSize(7).fillColor('#64748b').text(
        'THIS IS A SYSTEM GENERATED RECEIPT. SIGNATURE IS NOT REQUIRED.',
        leftMargin,
        footerDividerY + 8,
        { width: contentWidth, align: 'center', characterSpacing: 0.5 }
      );

      doc.moveTo(leftMargin, footerDividerY + 22).lineTo(rightMargin, footerDividerY + 22).lineWidth(0.6).stroke('#cbd5e1');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
