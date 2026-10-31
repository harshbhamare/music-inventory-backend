import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { AppSetting } from '../models/AppSetting.js';
// Convert number to Indian currency words
export function numberToIndianWords(num) {
    if (num === 0)
        return 'INR Zero Only';
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
    const inWords = (n) => {
        let str = '';
        if (n > 19) {
            str += b[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + a[n % 10] : ' ');
        }
        else {
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
    if (crore > 0)
        result += inWords(crore) + 'Crore ';
    const lakh = Math.floor(n / 100000);
    n %= 100000;
    if (lakh > 0)
        result += inWords(lakh) + 'Lakh ';
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    if (thousand > 0)
        result += inWords(thousand) + 'Thousand ';
    const hundred = Math.floor(n / 100);
    n %= 100;
    if (hundred > 0)
        result += inWords(hundred) + 'Hundred ';
    if (n > 0) {
        if (result !== '')
            result += 'and ';
        result += inWords(n);
    }
    let finalWords = 'INR ' + result.trim();
    if (fraction > 0) {
        finalWords += ' and ' + inWords(fraction).trim() + ' Paise';
    }
    return finalWords + ' Only';
}
export function formatIndianCurrency(num) {
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
function resolveTemplateImagePath() {
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
export async function generateTaxInvoicePdf(sale) {
    let setting = null;
    try {
        if (mongoose.connection && mongoose.connection.readyState === 1) {
            setting = await AppSetting.findOne().lean();
        }
    }
    catch {
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
    const pad = (n) => String(n).padStart(2, '0');
    const dateFormatted = `${pad(invoiceDate.getDate())}/${pad(invoiceDate.getMonth() + 1)}/${invoiceDate.getFullYear()}`;
    const buyerName = sale.customerName || 'Customer';
    const buyerPhone = sale.customerPhone || '';
    const buyerEmail = sale.customerEmail || '';
    const paymentMethod = sale.paymentMethod || 'Gpay';
    const templatePath = resolveTemplateImagePath();
    const fonts = resolveSystemFonts();
    return new Promise((resolve, reject) => {
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
            const chunks = [];
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
            lineItems.forEach((li, index) => {
                const prodName = li.product?.name || 'Instrument / Musical Accessory';
                const brand = li.product?.brand ? ` ${li.product.brand}` : '';
                const color = li.product?.color ? ` (${li.product.color})` : '';
                const hsn = li.hsnCode || li.product?.hsnCode || '92029000';
                const qty = li.quantity || 1;
                const unitPrice = li.unitPrice || 0;
                const discountPerUnit = li.discount || 0;
                const itemDiscount = discountPerUnit * qty;
                const totalAmount = li.total ?? Math.max(0, (qty * unitPrice) - itemDiscount);
                const hasSerials = li.serializedItemIds && li.serializedItemIds.length > 0;
                const hasDiscount = itemDiscount > 0;
                const rowHeight = hasSerials || hasDiscount ? 42 : 36;
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
                if (hasDiscount) {
                    subLine += ` | Discount: -${fonts.symbolPrefix}${formatIndianCurrency(itemDiscount)}`;
                }
                if (hasSerials) {
                    const serials = li.serializedItemIds.map((s) => s.assetId || s.manufacturerSerial || s).join(', ');
                    subLine += ` | SN: ${serials}`;
                }
                doc.font(fonts.regular).fontSize(7.5).fillColor(hasDiscount ? '#059669' : '#64748b');
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
            const summaryStartY = currentY + 16;
            const isEmiSale = sale.isEmi === true || sale.saleType === 'EMI';
            const grossSubtotal = sale.subtotal || lineItems.reduce((acc, li) => acc + (li.unitPrice || 0) * (li.quantity || 1), 0);
            const discountTotal = sale.discountTotal ?? lineItems.reduce((acc, li) => acc + (li.discount || 0) * (li.quantity || 1), 0);
            const taxableAmount = sale.taxableAmount ?? Math.max(0, grossSubtotal - discountTotal);
            const cgstAmount = sale.cgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;
            const sgstAmount = sale.sgstAmount || Math.round(taxableAmount * 0.09 * 100) / 100;
            const grandTotal = Math.round(sale.grandTotal || (taxableAmount + cgstAmount + sgstAmount));
            const totalsBoxX = 350;
            const totalsWidth = rightMargin - totalsBoxX;
            let totY = summaryStartY;
            // Left: Payment Method or EMI Financing Facility Box
            if (isEmiSale) {
                const emiBoxWidth = totalsBoxX - leftMargin - 15;
                const downPayment = Math.round(sale.downPayment || 0);
                const financedAmt = Math.round(Math.max(0, grandTotal - downPayment));
                const totalPaid = Math.round(sale.totalEmiPaid ?? downPayment);
                const totalDue = Math.round(sale.totalEmiDue ?? financedAmt);
                const tenure = sale.emiTenureMonths || 6;
                const monthlyAmt = sale.monthlyEmiAmount || (tenure > 0 ? Math.round(financedAmt / tenure) : 0);
                const emiBoxHeight = 114;
                doc.roundedRect(leftMargin, summaryStartY, emiBoxWidth, emiBoxHeight, 4).fillAndStroke('#f8fafc', '#cbd5e1');
                // Header ribbon
                doc.roundedRect(leftMargin, summaryStartY, emiBoxWidth, 20, 4).fill('#0284c7');
                doc.font(fonts.bold).fontSize(8.5).fillColor('#ffffff').text('CUSTOMER EMI FINANCING & REPAYMENT TERMS', leftMargin + 8, summaryStartY + 5);
                let rowY = summaryStartY + 25;
                const drawEmiRow = (label, value, isBold = false, valColor = '#0f172a') => {
                    doc.font(fonts.bold).fontSize(8).fillColor('#64748b').text(label, leftMargin + 8, rowY);
                    doc.font(isBold ? fonts.bold : fonts.regular).fontSize(8).fillColor(valColor).text(value, leftMargin + 130, rowY, { width: emiBoxWidth - 138, align: 'right' });
                    rowY += 12;
                };
                drawEmiRow('Payment Mode', `Customer EMI Plan (${tenure} Months)`);
                drawEmiRow('Initial Deposit / Down Payment', `${fonts.symbolPrefix}${formatIndianCurrency(downPayment)}`, true, '#059669');
                drawEmiRow('Financed Principal', `${fonts.symbolPrefix}${formatIndianCurrency(financedAmt)}`);
                drawEmiRow('Monthly Installment', `${fonts.symbolPrefix}${formatIndianCurrency(monthlyAmt)} / Month`);
                drawEmiRow('Total Collected to Date', `${fonts.symbolPrefix}${formatIndianCurrency(totalPaid)}`, true, '#059669');
                drawEmiRow('Outstanding EMI Balance', `${fonts.symbolPrefix}${formatIndianCurrency(totalDue)}`, true, totalDue > 0 ? '#e11d48' : '#059669');
                drawEmiRow('Financing Status', totalDue <= 0 ? 'COMPLETED / FULLY PAID' : 'ACTIVE EMI REPAYMENT', true, totalDue <= 0 ? '#059669' : '#0284c7');
            }
            else {
                doc.font(fonts.bold).fontSize(9.5).fillColor('#0f172a').text('Payment Method', leftMargin, summaryStartY);
                doc.font(fonts.regular).fontSize(8.5).fillColor('#334155').text(paymentMethod, leftMargin, summaryStartY + 14);
            }
            // Right: Totals
            const renderTotalLine = (label, amount, isDiscount = false) => {
                doc.font(fonts.regular).fontSize(8.5).fillColor(isDiscount ? '#059669' : '#334155').text(label, totalsBoxX, totY);
                doc.font(fonts.regular).fontSize(8.5).fillColor(isDiscount ? '#059669' : '#0f172a').text(`${isDiscount ? '(-) ' : ''}${fonts.symbolPrefix}${formatIndianCurrency(amount)}`, totalsBoxX, totY, { width: totalsWidth, align: 'right' });
                totY += 14;
            };
            if (discountTotal > 0) {
                renderTotalLine('Subtotal', grossSubtotal);
                renderTotalLine('Less: Discount Offered', discountTotal, true);
                renderTotalLine('Taxable Amount', taxableAmount);
            }
            else {
                renderTotalLine('Subtotal', taxableAmount);
            }
            renderTotalLine('CGST (9%)', cgstAmount);
            renderTotalLine('SGST (9%)', sgstAmount);
            if (isEmiSale) {
                const downPayment = Math.round(sale.downPayment || 0);
                const financedAmt = Math.round(Math.max(0, grandTotal - downPayment));
                const totalDue = Math.round(sale.totalEmiDue ?? financedAmt);
                // Highlighted TOTAL (INR) Bar
                const totalBarY = totY + 2;
                const totalBarHeight = 22;
                doc.rect(totalsBoxX - 6, totalBarY, totalsWidth + 6, totalBarHeight).fill('#e1f0fa');
                doc.font(fonts.bold).fontSize(9).fillColor('#0f172a').text('TOTAL INVOICE (INR)', totalsBoxX, totalBarY + 5.5);
                doc.font(fonts.bold).fontSize(9.5).fillColor('#0f172a').text(`${fonts.symbolPrefix}${formatIndianCurrency(grandTotal)}`, totalsBoxX, totalBarY + 5.5, { width: totalsWidth, align: 'right' });
                totY = totalBarY + totalBarHeight + 5;
                // Down payment deduction row
                doc.font(fonts.bold).fontSize(8.5).fillColor('#059669').text('Less: Deposit Paid', totalsBoxX, totY);
                doc.font(fonts.bold).fontSize(8.5).fillColor('#059669').text(`(-) ${fonts.symbolPrefix}${formatIndianCurrency(downPayment)}`, totalsBoxX, totY, { width: totalsWidth, align: 'right' });
                totY += 14;
                // Remaining EMI Balance Due Highlight
                const emiBarHeight = 22;
                doc.rect(totalsBoxX - 6, totY, totalsWidth + 6, emiBarHeight).fill('#fef3c7');
                doc.font(fonts.bold).fontSize(8.5).fillColor('#92400e').text('NET EMI BALANCE DUE', totalsBoxX, totY + 5.5);
                doc.font(fonts.bold).fontSize(9.5).fillColor('#92400e').text(`${fonts.symbolPrefix}${formatIndianCurrency(totalDue)}`, totalsBoxX, totY + 5.5, { width: totalsWidth, align: 'right' });
                totY += emiBarHeight;
            }
            else {
                const totalBarY = totY + 2;
                const totalBarHeight = 26;
                doc.rect(totalsBoxX - 6, totalBarY, totalsWidth + 6, totalBarHeight).fill('#e1f0fa');
                doc.font(fonts.bold).fontSize(9.5).fillColor('#0f172a').text('TOTAL (INR)', totalsBoxX, totalBarY + 7);
                doc.font(fonts.bold).fontSize(10.5).fillColor('#0f172a').text(`${fonts.symbolPrefix}${formatIndianCurrency(grandTotal)}`, totalsBoxX, totalBarY + 6.5, { width: totalsWidth, align: 'right' });
                totY = totalBarY + totalBarHeight;
            }
            // 7. Optional EMI Repayment Schedule Ledger
            let afterSummaryY = Math.max(summaryStartY + (isEmiSale ? 122 : 45), totY + 14);
            if (isEmiSale && sale.emiPayments && sale.emiPayments.length > 0) {
                doc.font(fonts.bold).fontSize(8.5).fillColor('#0f172a').text('MONTH-BY-MONTH EMI REPAYMENT SCHEDULE & LEDGER', leftMargin, afterSummaryY);
                afterSummaryY += 12;
                const schedHeaderHeight = 16;
                doc.rect(leftMargin, afterSummaryY, contentWidth, schedHeaderHeight).fill('#1e293b');
                doc.font(fonts.bold).fontSize(7.5).fillColor('#ffffff');
                doc.text('Installment', leftMargin + 6, afterSummaryY + 4, { width: 100 });
                doc.text('Due Date', leftMargin + 110, afterSummaryY + 4, { width: 75 });
                doc.text(`Amount Due (${fonts.symbolPrefix})`, leftMargin + 190, afterSummaryY + 4, { width: 75, align: 'right' });
                doc.text(`Amount Paid (${fonts.symbolPrefix})`, leftMargin + 275, afterSummaryY + 4, { width: 75, align: 'right' });
                doc.text('Status', leftMargin + 360, afterSummaryY + 4, { width: 60, align: 'center' });
                doc.text('Transaction Ref', leftMargin + 425, afterSummaryY + 4, { width: 85, align: 'center' });
                let schedRowY = afterSummaryY + schedHeaderHeight;
                sale.emiPayments.forEach((p) => {
                    const rowH = 14;
                    const isPaid = p.status === 'PAID';
                    doc.rect(leftMargin, schedRowY, contentWidth, rowH).fill(isPaid ? '#f0fdf4' : '#ffffff');
                    doc.rect(leftMargin, schedRowY, contentWidth, rowH).lineWidth(0.4).stroke('#e2e8f0');
                    doc.font(fonts.regular).fontSize(7.5).fillColor('#0f172a');
                    doc.text(p.billingMonth || `Month ${p.monthIndex}`, leftMargin + 6, schedRowY + 3, { width: 100 });
                    doc.text(p.dueDate ? new Date(p.dueDate).toLocaleDateString('en-IN') : '—', leftMargin + 110, schedRowY + 3, { width: 75 });
                    doc.text(formatIndianCurrency(p.amountDue), leftMargin + 190, schedRowY + 3, { width: 75, align: 'right' });
                    doc.font(fonts.bold).fillColor(p.amountPaid > 0 ? '#059669' : '#64748b').text(formatIndianCurrency(p.amountPaid || 0), leftMargin + 275, schedRowY + 3, { width: 75, align: 'right' });
                    doc.font(fonts.bold).fontSize(7).fillColor(isPaid ? '#059669' : '#d97706').text(p.status, leftMargin + 360, schedRowY + 3, { width: 60, align: 'center' });
                    doc.font(fonts.regular).fontSize(7).fillColor('#64748b').text(p.transactionRef || (isPaid ? 'Counter' : '—'), leftMargin + 425, schedRowY + 3, { width: 85, align: 'center' });
                    schedRowY += rowH;
                });
                afterSummaryY = schedRowY + 10;
            }
            // 8. Divider Line below Totals
            const lowerDividerY = afterSummaryY + 8;
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
            doc.font(fonts.regular).fontSize(7).fillColor('#64748b').text('THIS IS A SYSTEM GENERATED RECEIPT. SIGNATURE IS NOT REQUIRED.', leftMargin, footerDividerY + 8, { width: contentWidth, align: 'center', characterSpacing: 0.5 });
            doc.moveTo(leftMargin, footerDividerY + 22).lineTo(rightMargin, footerDividerY + 22).lineWidth(0.6).stroke('#cbd5e1');
            doc.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
