import { connectDB, disconnectDB } from '../config/db.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { Sale } from '../models/Sale.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { StockMovement } from '../models/StockMovement.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { Category } from '../models/Category.js';

async function inspect() {
  console.log('Connecting to database...');
  await connectDB();

  try {
    console.log('\n=== 1. PRODUCTS & INVENTORY ===');
    const products = await Product.find().lean();
    console.log(`Total Products: ${products.length}`);
    for (const p of products) {
      console.log(`- [${p.sku}] ${p.name} (${p.trackingMode}): OnHand=${p.stockQuantity?.onHand}, Reserved=${p.stockQuantity?.reserved}, IssuedInternal=${p.stockQuantity?.issuedInternal}, Quarantined=${p.stockQuantity?.quarantined}, UnitCost=${p.purchaseCost}, DefaultPrice=${p.defaultSellingPrice}, Active=${p.isActive}`);
    }

    console.log('\n=== 2. SERIALIZED ITEMS ===');
    const serials = await SerializedItem.find().populate('product', 'name sku').lean();
    console.log(`Total Serialized Items: ${serials.length}`);
    for (const s of serials) {
      console.log(`- Serial [${s.assetId || s.manufacturerSerial}] Prod: ${(s.product as any)?.name} Status: ${s.status} Condition: ${s.condition} UnitCost: ${s.unitCost}`);
    }

    console.log('\n=== 3. SALES TRANSACTIONS ===');
    const sales = await Sale.find().populate('lineItems.product', 'name sku purchaseCost defaultSellingPrice').lean();
    console.log(`Total Sales: ${sales.length}`);
    for (const s of sales) {
      console.log(`- Sale ${s.invoiceNumber}: Status=${s.saleStatus}, PaymentStatus=${s.paymentStatus}, GrandTotal=${s.grandTotal}, Subtotal=${s.subtotal}, Taxable=${s.taxableAmount}, Tax=${s.taxTotal}, DownPayment=${s.downPayment}, TotalEmiPaid=${s.totalEmiPaid}, TotalEmiDue=${s.totalEmiDue}, isEmi=${s.isEmi}`);
      console.log(`  LineItems: ${JSON.stringify(s.lineItems.map(li => ({ prod: (li.product as any)?.name, qty: li.quantity, unitPrice: li.unitPrice, discount: li.discount, total: li.total, unitCost: (li.product as any)?.purchaseCost })))}`);
      if (s.isEmi) {
        console.log(`  EMIPayments: ${s.emiPayments?.length} installments, ${s.emiPayments?.filter(p => p.status === 'PAID').length} paid, ${s.emiPayments?.filter(p => p.status !== 'PAID').length} unpaid`);
      }
      if (s.paymentLogs && s.paymentLogs.length > 0) {
        console.log(`  PaymentLogs: ${JSON.stringify(s.paymentLogs.map(l => ({ type: l.paymentType, amount: l.amount, method: l.paymentMethod, month: l.billingMonth })))}`);
      }
    }

    console.log('\n=== 4. RENTALS & INTERNAL USAGE ===');
    const usages = await InternalUsage.find().populate('items.product', 'name sku purchaseCost').populate('items.serializedItemId', 'assetId unitCost').lean();
    console.log(`Total Usages/Rentals: ${usages.length}`);
    for (const u of usages) {
      console.log(`- Rental ${u.issueReference} (${u.assignedPerson}): Status=${u.status}, isRental=${u.isRental}, MonthlyRent=${u.monthlyRent}, Deposit=${u.securityDeposit}, PaidRent=${u.totalRentPaid}, DueRent=${u.totalRentDue}`);
      console.log(`  Items: ${JSON.stringify(u.items?.map(it => ({ prod: (it.product as any)?.name, serial: (it.serializedItemId as any)?.assetId, cost: (it.serializedItemId as any)?.unitCost || (it.product as any)?.purchaseCost, issued: it.quantityIssued, returned: it.quantityReturned })))}`);
      if (u.monthlyPayments && u.monthlyPayments.length > 0) {
        console.log(`  MonthlyPayments: ${u.monthlyPayments.length} months. Paid: ${JSON.stringify(u.monthlyPayments.map(p => ({ month: p.billingMonth, due: p.amountDue, paid: p.amountPaid, status: p.status })))}`);
      }
    }

    console.log('\n=== 5. MAINTENANCE RECORDS ===');
    const maints = await MaintenanceRecord.find().lean();
    console.log(`Total Maintenance Records: ${maints.length}`);
    for (const m of maints) {
      console.log(`- Maintenance [${m.status}]: Cost=${m.cost}, Problem=${m.problemDescription}, Product=${m.product}, Serial=${m.serializedItem}`);
    }

    console.log('\n=== 6. PURCHASE RECEIPTS ===');
    const receipts = await PurchaseReceipt.find().lean();
    console.log(`Total Receipts: ${receipts.length}`);
    for (const r of receipts) {
      console.log(`- Receipt ${r.receiptNumber} (${r.receivedDate}): Items=${JSON.stringify(r.lineItems)}`);
    }

    console.log('\n=== 7. LEDGER RECONCILIATION AUDIT ===');
    const { runInventoryReconciliation } = await import('../services/reconciliationService.js');
    const recon = await runInventoryReconciliation();
    console.log(`Reconciliation results: Checked=${recon.totalProductsChecked}, Mismatches=${recon.mismatchesFound}`);
    for (const res of recon.results) {
      if (res.hasMismatch) {
        console.log(`  MISMATCH: Product ${res.productName} (${res.sku}) - RecordedOnHand=${res.recordedOnHand}, CalculatedFromLedger=${res.calculatedFromLedger}, SerializedPhysical=${res.serializedPhysicalCount}, Delta=${res.discrepancyDelta}`);
      }
    }

  } catch (err) {
    console.error('Error during inspection:', err);
  } finally {
    await disconnectDB();
  }
}

inspect();
