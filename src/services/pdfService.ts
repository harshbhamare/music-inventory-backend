import PDFDocument from 'pdfkit';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { ISale } from '../models/Sale.js';
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

export async function generateTaxInvoicePdf(sale: any): Promise<Buffer> {
  let setting: any = null;
  try {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      setting = await AppSetting.findOne().lean();
    }
  } catch {
    setting = null;
  }

  const companyName = setting?.companyName || 'Stereobliss';
  const supplierAddress = setting?.address || '';
  const supplierPhone = setting?.contactPhone || '';
  const supplierEmail = setting?.contactEmail || '';
  const supplierGstin = setting?.gstin || '';
  const supplierState = setting?.stateName || 'Maharashtra';
  const supplierStateCode = setting?.stateCode || '27';

  const invoiceNo = sale.invoiceNumber || 'INV-2026-0001';
  const invoiceDate = new Date(sale.createdAt || Date.now());
  const dateFormatted = invoiceDate.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });

  const buyerName = sale.customerName || 'Valued Customer';
  const buyerPhone = sale.customerPhone || '';
  const buyerEmail = sale.customerEmail || '';
  const buyerAddress = sale.customerAddress || '-';
  const buyerGstin = sale.customerGstin || (supplierGstin ? 'Unregistered / B2C' : 'N/A');
  const buyerState = 'Maharashtra';
  const buyerStateCode = '27';

  const eWayBillNo = sale.eWayBillNo || `28${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  const dispatchThrough = sale.dispatchThrough || 'XP India';
  const destination = sale.destination || 'PUNE';
  const paymentMethod = sale.paymentMethod || 'UPI';

  // Deterministic IRN and Ack based on invoice
  const irnSeed = `${invoiceNo}-${invoiceDate.toISOString()}-${sale.grandTotal}`;
  const irn =
    sale.irn ||
    crypto.createHash('sha256').update(irnSeed).digest('hex').substring(0, 64);
  const ackNo = sale.ackNo || `1226${Math.floor(10000000000 + Math.random() * 90000000000)}`;
  const ackDate = dateFormatted;

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 24,
        info: {
          Title: `Tax Invoice - ${invoiceNo}`,
          Author: companyName,
          Subject: 'Official GST Tax Invoice',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const leftMargin = 24;
      const topMargin = 24;
      const pageWidth = 547; // 595.28 - 48
      const colMid = leftMargin + 270;

      // Outer border for authentic tax invoice appearance
      const invoiceHeight = 794;
      doc.rect(leftMargin, topMargin, pageWidth, invoiceHeight).lineWidth(0.75).stroke('#000000');

      // 1. Header Section
      doc.font('Helvetica-Bold').fontSize(11).text('TAX INVOICE', leftMargin, topMargin + 6, {
        align: 'center',
        width: pageWidth,
      });
      doc.font('Helvetica').fontSize(7.5).text('(ORIGINAL FOR RECIPIENT)', leftMargin, topMargin + 19, {
        align: 'center',
        width: pageWidth,
      });

      // IRN, Ack No, Ack Date (Left/top under header without QR code)
      let metaY = topMargin + 32;
      doc.font('Helvetica').fontSize(6.5);
      doc.text(`IRN:`, leftMargin + 8, metaY);
      doc.font('Helvetica-Bold').fontSize(6.5).text(irn, leftMargin + 50, metaY, { width: pageWidth - 60 });
      metaY += 11;
      doc.font('Helvetica').fontSize(6.5);
      doc.text(`Ack No:`, leftMargin + 8, metaY);
      doc.font('Helvetica-Bold').fontSize(6.5).text(ackNo, leftMargin + 50, metaY, { continued: true });
      doc.font('Helvetica').text(`       Ack Date: `, { continued: true });
      doc.font('Helvetica-Bold').text(ackDate);

      // Horizontal separator line below header
      const headerBottomY = topMargin + 65;
      doc.moveTo(leftMargin, headerBottomY).lineTo(leftMargin + pageWidth, headerBottomY).lineWidth(0.5).stroke('#000000');

      // 2. Middle Section: Two Columns (Supplier/Consignee/Buyer on Left, Invoice Details on Right)
      const midSectionHeight = 175;
      const sectionBottomY = headerBottomY + midSectionHeight;

      // Vertical line separating Left and Right blocks
      doc.moveTo(colMid, headerBottomY).lineTo(colMid, sectionBottomY).lineWidth(0.5).stroke('#000000');

      // --- LEFT COLUMN ---
      let leftY = headerBottomY + 4;
      // Supplier (Sushma Enterprises / Stereobliss)
      doc.font('Helvetica-Bold').fontSize(8.5).text(companyName, leftMargin + 6, leftY);
      leftY += 10;
      doc.font('Helvetica').fontSize(6.5);
      doc.text(supplierAddress, leftMargin + 6, leftY, { width: 255 });
      leftY += 16;
      doc.text(`Tel : ${supplierPhone}`, leftMargin + 6, leftY);
      leftY += 8;
      doc.text(`GSTIN/UIN: `, leftMargin + 6, leftY, { continued: true });
      doc.font('Helvetica-Bold').text(supplierGstin);
      leftY += 8;
      doc.font('Helvetica').text(`State Name : ${supplierState}, Code : ${supplierStateCode}`, leftMargin + 6, leftY);
      leftY += 8;
      doc.text(`E-Mail : ${supplierEmail}`, leftMargin + 6, leftY);
      leftY += 10;

      // Divider between Supplier and Consignee
      doc.moveTo(leftMargin, leftY).lineTo(colMid, leftY).lineWidth(0.25).stroke('#777777');
      leftY += 3;

      // Consignee (Ship to)
      doc.font('Helvetica-Bold').fontSize(7).text('Consignee (Ship to)', leftMargin + 6, leftY);
      leftY += 9;
      doc.font('Helvetica-Bold').fontSize(7.5).text(buyerName, leftMargin + 6, leftY);
      leftY += 9;
      doc.font('Helvetica').fontSize(6.5).text(buyerAddress, leftMargin + 6, leftY, { width: 255 });
      leftY += 15;
      if (buyerPhone) {
        doc.text(`Ph No : ${buyerPhone}`, leftMargin + 6, leftY);
        leftY += 8;
      }
      doc.text(`GSTIN/UIN    : `, leftMargin + 6, leftY, { continued: true });
      doc.font('Helvetica-Bold').text(buyerGstin);
      leftY += 8;
      doc.font('Helvetica').text(`State Name   : ${buyerState}, Code : ${buyerStateCode}`, leftMargin + 6, leftY);
      leftY += 10;

      // Divider between Consignee and Buyer
      doc.moveTo(leftMargin, leftY).lineTo(colMid, leftY).lineWidth(0.25).stroke('#777777');
      leftY += 3;

      // Buyer (Bill to)
      doc.font('Helvetica-Bold').fontSize(7).text('Buyer (Bill to)', leftMargin + 6, leftY);
      leftY += 8;
      doc.font('Helvetica-Bold').fontSize(7.5).text(buyerName, leftMargin + 6, leftY);
      leftY += 9;
      doc.font('Helvetica').fontSize(6.5).text(buyerAddress, leftMargin + 6, leftY, { width: 255 });
      leftY += 14;
      doc.text(`GSTIN/UIN    : `, leftMargin + 6, leftY, { continued: true });
      doc.font('Helvetica-Bold').text(buyerGstin);
      leftY += 8;
      doc.font('Helvetica').text(`State Name   : ${buyerState}, Code : ${buyerStateCode}`, leftMargin + 6, leftY);

      // --- RIGHT COLUMN ---
      let rightY = headerBottomY;
      const rightColWidth = pageWidth - (colMid - leftMargin);

      const renderRightRow = (label1: string, val1: string, label2: string, val2: string, rowH = 15) => {
        const halfW = rightColWidth / 2;
        doc.font('Helvetica').fontSize(6.5).text(label1, colMid + 6, rightY + 2);
        doc.font('Helvetica-Bold').fontSize(7).text(val1, colMid + 6, rightY + 9);

        // Vertical divider between the two sub-columns
        doc.moveTo(colMid + halfW, rightY).lineTo(colMid + halfW, rightY + rowH).lineWidth(0.25).stroke('#999999');

        doc.font('Helvetica').fontSize(6.5).text(label2, colMid + halfW + 6, rightY + 2);
        doc.font('Helvetica-Bold').fontSize(7).text(val2, colMid + halfW + 6, rightY + 9);

        rightY += rowH;
        doc.moveTo(colMid, rightY).lineTo(leftMargin + pageWidth, rightY).lineWidth(0.25).stroke('#999999');
      };

      renderRightRow('Invoice No.', invoiceNo, 'e-Way Bill No.', eWayBillNo, 18);
      renderRightRow('Delivery Note', '', 'Dated', dateFormatted, 18);
      renderRightRow('Reference No. & Date.', '', 'Mode/Terms of Payment', paymentMethod, 18);
      renderRightRow('Other References', '', '', '', 16);
      renderRightRow("Buyer's Order No.", '', 'Dated', '', 16);
      renderRightRow('Dispatch Doc No.', '', 'Delivery Note Date', '', 16);
      renderRightRow('Dispatched through', dispatchThrough, 'Destination', destination, 18);

      // Terms of delivery box at bottom of right column
      doc.font('Helvetica').fontSize(6.5).text('Terms of Delivery', colMid + 6, rightY + 3);
      doc.font('Helvetica').fontSize(6.5).text(sale.remarks || sale.notes || 'Immediate Delivery, Standard Store Warranty', colMid + 6, rightY + 12, { width: rightColWidth - 12 });

      // Horizontal line separating top details and Table
      doc.moveTo(leftMargin, sectionBottomY).lineTo(leftMargin + pageWidth, sectionBottomY).lineWidth(0.75).stroke('#000000');

      // 3. TABLE OF GOODS
      const tableHeaderY = sectionBottomY;
      const tableHeaderHeight = 16;
      const colX = {
        sl: leftMargin,
        desc: leftMargin + 24,
        hsn: leftMargin + 245,
        qty: leftMargin + 310,
        rate: leftMargin + 375,
        per: leftMargin + 445,
        amount: leftMargin + 480,
      };

      // Header row background & text
      doc.font('Helvetica-Bold').fontSize(7);
      doc.text('Sl\nNo.', colX.sl + 2, tableHeaderY + 2, { width: 22, align: 'center' });
      doc.text('Description of Goods', colX.desc + 4, tableHeaderY + 4);
      doc.text('HSN/SAC', colX.hsn, tableHeaderY + 4, { width: 60, align: 'center' });
      doc.text('Quantity', colX.qty, tableHeaderY + 4, { width: 60, align: 'center' });
      doc.text('Rate', colX.rate, tableHeaderY + 4, { width: 65, align: 'right' });
      doc.text('per', colX.per, tableHeaderY + 4, { width: 30, align: 'center' });
      doc.text('Amount', colX.amount, tableHeaderY + 4, { width: 60, align: 'right' });

      const tableDataStartY = tableHeaderY + tableHeaderHeight;
      doc.moveTo(leftMargin, tableDataStartY).lineTo(leftMargin + pageWidth, tableDataStartY).lineWidth(0.5).stroke('#000000');

      // Render line items
      let rowY = tableDataStartY + 3;
      const lineItems = sale.lineItems || [];

      lineItems.forEach((li: any, index: number) => {
        const prodName = li.product?.name || 'Musical Instrument';
        const brand = li.product?.brand ? ` (${li.product.brand})` : '';
        const color = li.product?.color ? ` - ${li.product.color}` : '';
        const hsn = li.hsnCode || (li.product as any)?.hsnCode || '92029000';
        const qtyStr = `${li.quantity} Nos.`;
        const rateStr = formatIndianCurrency(li.unitPrice);
        const amountStr = formatIndianCurrency(li.total || (li.quantity * li.unitPrice));

        doc.font('Helvetica').fontSize(7.5);
        doc.text(String(index + 1), colX.sl, rowY, { width: 24, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(7.5);
        doc.text(`${prodName}${brand}${color}`, colX.desc + 4, rowY, { width: 215 });

        // If serial numbers exist, print below
        if (li.serializedItemIds && li.serializedItemIds.length > 0) {
          const serials = li.serializedItemIds.map((s: any) => s.assetId || s).join(', ');
          doc.font('Helvetica-Oblique').fontSize(6).text(`SN: ${serials}`, colX.desc + 4, rowY + 9, { width: 215 });
        }

        doc.font('Helvetica').fontSize(7.5);
        doc.text(hsn, colX.hsn, rowY, { width: 60, align: 'center' });
        doc.font('Helvetica-Bold').text(qtyStr, colX.qty, rowY, { width: 60, align: 'center' });
        doc.font('Helvetica').text(rateStr, colX.rate, rowY, { width: 65, align: 'right' });
        doc.text('Nos', colX.per, rowY, { width: 30, align: 'center' });
        doc.font('Helvetica-Bold').text(amountStr, colX.amount, rowY, { width: 60, align: 'right' });

        rowY += (li.serializedItemIds && li.serializedItemIds.length > 0 ? 19 : 14);
      });

      // CGST & SGST Rows inside table
      const taxableAmount = sale.taxableAmount || (sale.subtotal - (sale.discountTotal || 0));
      const cgstAmount = sale.cgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;
      const sgstAmount = sale.sgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;

      rowY = Math.max(rowY + 10, tableDataStartY + 140);

      doc.font('Helvetica-Oblique').fontSize(7.5);
      doc.text('Output @ CGST', colX.desc + 120, rowY);
      doc.font('Helvetica-Bold').text(formatIndianCurrency(cgstAmount), colX.amount, rowY, { width: 60, align: 'right' });
      rowY += 12;

      doc.font('Helvetica-Oblique').fontSize(7.5);
      doc.text('Output @ SGST', colX.desc + 120, rowY);
      doc.font('Helvetica-Bold').text(formatIndianCurrency(sgstAmount), colX.amount, rowY, { width: 60, align: 'right' });
      rowY += 14;

      // Table bottom / Total row
      const tableBottomY = 660;

      // Draw vertical column lines down to tableBottomY
      const vLines = [colX.desc, colX.hsn, colX.qty, colX.rate, colX.per, colX.amount];
      vLines.forEach((x) => {
        doc.moveTo(x, tableHeaderY).lineTo(x, tableBottomY).lineWidth(0.5).stroke('#000000');
      });

      // Total row line
      doc.moveTo(leftMargin, tableBottomY).lineTo(leftMargin + pageWidth, tableBottomY).lineWidth(0.75).stroke('#000000');

      // Total row contents
      const totalRowHeight = 18;
      doc.font('Helvetica-Bold').fontSize(8.5);
      doc.text('Total', colX.desc + 4, tableBottomY + 4);

      const totalQty = lineItems.reduce((acc: number, li: any) => acc + (li.quantity || 0), 0);
      doc.text(`${totalQty} Nos.`, colX.qty, tableBottomY + 4, { width: 60, align: 'center' });
      doc.text(`INR ${formatIndianCurrency(sale.grandTotal)}`, colX.amount - 20, tableBottomY + 4, {
        width: 80,
        align: 'right',
      });

      const totalRowBottomY = tableBottomY + totalRowHeight;
      doc.moveTo(leftMargin, totalRowBottomY).lineTo(leftMargin + pageWidth, totalRowBottomY).lineWidth(0.75).stroke('#000000');

      // 4. Amount in Words
      const wordsY = totalRowBottomY + 6;
      doc.font('Helvetica').fontSize(7).text('Amount Chargeable (in words):', leftMargin + 8, wordsY);
      doc.font('Helvetica-Bold').fontSize(7.5).text(numberToIndianWords(sale.grandTotal), leftMargin + 8, wordsY + 9, {
        width: 320,
      });

      // Tax breakdown mini-table
      doc.font('Helvetica').fontSize(6.5);
      doc.text(`Taxable Value: INR ${formatIndianCurrency(taxableAmount)} | CGST 9%: INR ${formatIndianCurrency(cgstAmount)} | SGST 9%: INR ${formatIndianCurrency(sgstAmount)}`, leftMargin + 8, wordsY + 24);

      // Company Declaration & Signature box
      const sigBoxX = colMid + 30;
      doc.font('Helvetica').fontSize(7).text(`for ${companyName.toUpperCase()}`, sigBoxX, wordsY + 4, { align: 'right', width: pageWidth - (sigBoxX - leftMargin) - 8 });
      doc.font('Helvetica-Bold').fontSize(7.5).text('Authorised Signatory', sigBoxX, wordsY + 42, { align: 'right', width: pageWidth - (sigBoxX - leftMargin) - 8 });

      // 5. Footer Computer Generated Notice
      doc.moveTo(leftMargin, invoiceHeight + topMargin - 22).lineTo(leftMargin + pageWidth, invoiceHeight + topMargin - 22).lineWidth(0.5).stroke('#999999');
      doc.font('Helvetica-Oblique').fontSize(7).text('This is a Computer Generated Invoice', leftMargin, invoiceHeight + topMargin - 15, {
        align: 'center',
        width: pageWidth,
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
