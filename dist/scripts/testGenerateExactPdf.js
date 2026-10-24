import fs from 'fs';
import path from 'path';
import { generateTaxInvoicePdf } from '../services/pdfService.js';
async function run() {
    const sampleSale = {
        invoiceNumber: 'INV0058',
        customerName: 'Sneha Bhagat',
        customerPhone: '9970863148',
        customerEmail: 'snehal.d.bhagat@gmail.com',
        paymentMethod: 'Gpay',
        createdAt: new Date('2026-09-06T10:30:00Z'),
        lineItems: [
            {
                product: {
                    name: 'Yamaha Acoustic Guitar FS80C (BLK)',
                    brand: '',
                    color: '',
                },
                hsnCode: '92029000',
                quantity: 1,
                unitPrice: 7796.62,
                total: 7796.62,
            },
        ],
        subtotal: 7796.62,
        discountTotal: 0,
        taxableAmount: 7796.62,
        cgstAmount: 701.69,
        sgstAmount: 701.69,
        taxTotal: 1403.38,
        grandTotal: 9200.01,
    };
    console.log('Generating sample PDF matching reference_invoice.jpg...');
    const pdfBuffer = await generateTaxInvoicePdf(sampleSale);
    const outPath = path.resolve(process.cwd(), 'sample_generated_invoice.pdf');
    fs.writeFileSync(outPath, pdfBuffer);
    console.log('Successfully wrote:', outPath, 'Bytes:', pdfBuffer.length);
}
run().catch((err) => {
    console.error('PDF generation error:', err);
    process.exit(1);
});
