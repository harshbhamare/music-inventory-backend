import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { Sale } from '../models/Sale.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { StockMovement } from '../models/StockMovement.js';
import { Category } from '../models/Category.js';
import '../models/User.js';
import '../models/StockLocation.js';
import { SERIALIZED_STATUSES, USAGE_STATUSES, ADJUSTMENT_STATUSES, TRACKING_MODES, SALE_STATUSES, } from '../config/constants.js';
export async function getDashboardMetrics(startDate, endDate) {
    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();
    const now = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    // Execute all dashboard queries in parallel with field projections for maximum performance
    const [products, serializedSummary, serializedInUseCount, activeUsageCount, overdueUsageCount, instrumentsUnderMaintenanceCount, todayReceiptsCount, periodSales, pendingApprovalsCount, recentMovements, last7DaysSales,] = await Promise.all([
        Product.find({ isActive: true })
            .select('stockQuantity minStockThreshold purchaseCost defaultSellingPrice trackingMode')
            .lean(),
        SerializedItem.aggregate([
            {
                $match: {
                    status: { $nin: [SERIALIZED_STATUSES.SOLD, SERIALIZED_STATUSES.RETIRED] },
                },
            },
            {
                $group: {
                    _id: '$product',
                    count: { $sum: 1 },
                    totalCost: { $sum: '$unitCost' },
                },
            },
        ]),
        SerializedItem.countDocuments({ status: SERIALIZED_STATUSES.ISSUED_INTERNAL }),
        InternalUsage.countDocuments({
            status: { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED] },
        }),
        InternalUsage.countDocuments({
            status: { $in: [USAGE_STATUSES.ACTIVE, USAGE_STATUSES.PARTIALLY_RETURNED, USAGE_STATUSES.OVERDUE] },
            expectedReturnDate: { $lt: now },
        }),
        SerializedItem.countDocuments({ status: SERIALIZED_STATUSES.MAINTENANCE }),
        PurchaseReceipt.countDocuments({ receivedDate: { $gte: start, $lte: end } }),
        Sale.find({
            status: { $ne: 'CANCELLED' },
            createdAt: { $gte: start, $lte: end },
        })
            .select('grandTotal')
            .lean(),
        InventoryAdjustment.countDocuments({ status: ADJUSTMENT_STATUSES.PENDING_APPROVAL }),
        StockMovement.find()
            .populate('product', 'name sku brand color')
            .populate('serializedItem', 'assetId')
            .populate('performedBy', 'name role')
            .populate('location', 'name code')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        Sale.aggregate([
            {
                $match: {
                    status: { $ne: 'CANCELLED' },
                    createdAt: { $gte: sevenDaysAgo },
                },
            },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    revenue: { $sum: '$grandTotal' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]),
    ]);
    // Index serialized aggregation by productId string
    const serializedMap = new Map();
    for (const s of serializedSummary) {
        if (s._id) {
            serializedMap.set(s._id.toString(), { count: s.count, totalCost: s.totalCost });
        }
    }
    const distinctProductCount = products.length;
    let totalUnitsOnHand = 0;
    let totalAvailableForSale = 0;
    let lowStockCount = 0;
    let totalInventoryValuationAtCost = 0;
    let totalPotentialRetailValuation = 0;
    for (const p of products) {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        let onHand = sq.onHand || 0;
        // For serialized items, use verified serial counts if available
        const serData = serializedMap.get(p._id.toString());
        if (p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.count > 0) {
            onHand = Math.max(onHand, serData.count);
        }
        const unavailable = (sq.reserved || 0) + (sq.issuedInternal || 0) + (sq.quarantined || 0);
        const available = Math.max(0, onHand - unavailable);
        totalUnitsOnHand += onHand;
        totalAvailableForSale += available;
        if (available <= (p.minStockThreshold || 5)) {
            lowStockCount++;
        }
        // Accurate Valuation calculation
        if (p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.totalCost > 0) {
            totalInventoryValuationAtCost += serData.totalCost;
        }
        else {
            totalInventoryValuationAtCost += onHand * (p.purchaseCost || 0);
        }
        totalPotentialRetailValuation += onHand * (p.defaultSellingPrice || 0);
    }
    const periodSalesCount = periodSales.length;
    const periodSalesRevenue = periodSales.reduce((acc, s) => acc + (s.grandTotal || 0), 0);
    return {
        kpis: {
            totalUnitsOnHand,
            totalAvailableForSale,
            distinctProductCount,
            serializedInUseCount,
            lowStockCount,
            activeUsageCount,
            overdueUsageCount,
            instrumentsUnderMaintenanceCount,
            todayReceiptsCount,
            periodSalesCount,
            periodSalesRevenue,
            pendingApprovalsCount,
            totalInventoryValuationAtCost,
            totalPotentialRetailValuation,
        },
        recentMovements,
        salesTrend: last7DaysSales,
    };
}
export async function getInventoryValuationReport() {
    const [products, serializedSummary] = await Promise.all([
        Product.find({ isActive: true })
            .populate('category', 'name')
            .lean(),
        SerializedItem.aggregate([
            {
                $match: {
                    status: { $nin: [SERIALIZED_STATUSES.SOLD, SERIALIZED_STATUSES.RETIRED] },
                },
            },
            {
                $group: {
                    _id: '$product',
                    count: { $sum: 1 },
                    totalCost: { $sum: '$unitCost' },
                },
            },
        ]),
    ]);
    const serializedMap = new Map();
    for (const s of serializedSummary) {
        if (s._id) {
            serializedMap.set(s._id.toString(), { count: s.count, totalCost: s.totalCost });
        }
    }
    const reportItems = products.map((p) => {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        let onHand = sq.onHand || 0;
        const serData = serializedMap.get(p._id.toString());
        if (p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.count > 0) {
            onHand = Math.max(onHand, serData.count);
        }
        const valuationCost = p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.totalCost > 0
            ? serData.totalCost
            : onHand * (p.purchaseCost || 0);
        const potentialRetail = onHand * (p.defaultSellingPrice || 0);
        const potentialGrossMargin = potentialRetail - valuationCost;
        return {
            productId: p._id,
            name: p.name,
            sku: p.sku,
            brand: p.brand,
            category: p.category?.name || 'Uncategorized',
            trackingMode: p.trackingMode,
            onHand,
            available: Math.max(0, onHand - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0)),
            unitCost: p.purchaseCost,
            unitPrice: p.defaultSellingPrice,
            valuationCost,
            potentialRetail,
            potentialGrossMargin,
        };
    });
    const totals = reportItems.reduce((acc, item) => ({
        totalOnHand: acc.totalOnHand + item.onHand,
        totalValuationCost: acc.totalValuationCost + item.valuationCost,
        totalPotentialRetail: acc.totalPotentialRetail + item.potentialRetail,
        totalPotentialMargin: acc.totalPotentialMargin + item.potentialGrossMargin,
    }), { totalOnHand: 0, totalValuationCost: 0, totalPotentialRetail: 0, totalPotentialMargin: 0 });
    return { items: reportItems, totals };
}
export function generateCsv(headers, rows) {
    const escapeCell = (val) => {
        if (val === null || val === undefined)
            return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    };
    const headerRow = headers.map(escapeCell).join(',');
    const bodyRows = rows.map((r) => r.map(escapeCell).join(',')).join('\n');
    return `${headerRow}\n${bodyRows}`;
}
export async function getPeriodicSummary(period = 'week') {
    const now = new Date();
    const periods = [];
    if (period === 'week') {
        // Last 8 weeks
        for (let i = 7; i >= 0; i--) {
            const d = new Date(now);
            const day = d.getDay();
            const diffToMonday = (day + 6) % 7;
            const startOfWeek = new Date(d);
            startOfWeek.setDate(d.getDate() - diffToMonday - (i * 7));
            startOfWeek.setHours(0, 0, 0, 0);
            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);
            endOfWeek.setHours(23, 59, 59, 999);
            const startFmt = startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const endFmt = endOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            periods.push({
                periodKey: `W${i === 0 ? ' (Current)' : ` -${i}w`}`,
                label: `${startFmt} – ${endFmt}`,
                startDate: startOfWeek.toISOString(),
                endDate: endOfWeek.toISOString(),
                salesRevenue: 0,
                salesCount: 0,
                itemsSold: 0,
                cogs: 0,
                grossProfit: 0,
                grossMarginPercent: 0,
                receiptsCount: 0,
                receiptsValue: 0,
                adjustmentsCount: 0,
            });
        }
    }
    else {
        // Last 12 months
        for (let i = 11; i >= 0; i--) {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth() - i, 1, 0, 0, 0, 0);
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
            const label = startOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            periods.push({
                periodKey: startOfMonth.toLocaleDateString('en-US', { month: 'short' }),
                label,
                startDate: startOfMonth.toISOString(),
                endDate: endOfMonth.toISOString(),
                salesRevenue: 0,
                salesCount: 0,
                itemsSold: 0,
                cogs: 0,
                grossProfit: 0,
                grossMarginPercent: 0,
                receiptsCount: 0,
                receiptsValue: 0,
                adjustmentsCount: 0,
            });
        }
    }
    const overallStart = new Date(periods[0].startDate);
    const overallEnd = new Date(periods[periods.length - 1].endDate);
    const [sales, receipts, adjustments] = await Promise.all([
        Sale.find({
            $and: [
                { createdAt: { $gte: overallStart, $lte: overallEnd } },
                { saleStatus: { $ne: SALE_STATUSES.CANCELLED } },
            ],
        })
            .populate('lineItems.product', 'name sku purchaseCost')
            .lean(),
        PurchaseReceipt.find({ receivedDate: { $gte: overallStart, $lte: overallEnd } }).lean(),
        InventoryAdjustment.find({ createdAt: { $gte: overallStart, $lte: overallEnd } }).lean(),
    ]);
    const productSalesMap = new Map();
    // Map into respective period buckets
    for (const s of sales) {
        const saleDate = new Date(s.createdAt).getTime();
        const bucket = periods.find((p) => {
            const st = new Date(p.startDate).getTime();
            const et = new Date(p.endDate).getTime();
            return saleDate >= st && saleDate <= et;
        });
        const lineItems = (s.lineItems && s.lineItems.length > 0) ? s.lineItems : (s.items || []);
        let saleCogs = 0;
        let saleQty = 0;
        for (const li of lineItems) {
            const prod = li.product;
            const qty = li.quantity || 1;
            const unitCost = prod?.purchaseCost || 0;
            const itemCost = qty * unitCost;
            saleCogs += itemCost;
            saleQty += qty;
            if (prod && prod._id) {
                const id = prod._id.toString();
                const existing = productSalesMap.get(id) || {
                    name: prod.name || 'Product',
                    sku: prod.sku || '',
                    quantity: 0,
                    revenue: 0,
                    cogs: 0,
                    profit: 0,
                };
                existing.quantity += qty;
                existing.revenue += (li.total ?? (li.subtotal ?? (li.unitPrice * qty)));
                existing.cogs += itemCost;
                existing.profit = existing.revenue - existing.cogs;
                productSalesMap.set(id, existing);
            }
        }
        const saleRevenue = s.grandTotal || 0;
        const saleProfit = saleRevenue - saleCogs;
        if (bucket) {
            bucket.salesCount++;
            bucket.salesRevenue += saleRevenue;
            bucket.itemsSold += saleQty;
            bucket.cogs += saleCogs;
            bucket.grossProfit += saleProfit;
        }
    }
    for (const r of receipts) {
        const receiptDate = new Date(r.receivedDate || r.createdAt).getTime();
        const bucket = periods.find((p) => {
            const st = new Date(p.startDate).getTime();
            const et = new Date(p.endDate).getTime();
            return receiptDate >= st && receiptDate <= et;
        });
        if (bucket) {
            bucket.receiptsCount++;
            const receiptTotal = (r.lineItems || []).reduce((sum, item) => sum + (item.quantityReceived || 0) * (item.unitCost || 0), 0);
            bucket.receiptsValue += receiptTotal;
        }
    }
    for (const a of adjustments) {
        const adjDate = new Date(a.createdAt).getTime();
        const bucket = periods.find((p) => {
            const st = new Date(p.startDate).getTime();
            const et = new Date(p.endDate).getTime();
            return adjDate >= st && adjDate <= et;
        });
        if (bucket) {
            bucket.adjustmentsCount++;
        }
    }
    let totalRevenue = 0;
    let totalSalesCount = 0;
    let totalUnitsSold = 0;
    let totalCogs = 0;
    let totalGrossProfit = 0;
    let totalInwardPurchases = 0;
    let totalReceiptsCount = 0;
    for (const p of periods) {
        p.grossMarginPercent = p.salesRevenue > 0 ? Number(((p.grossProfit / p.salesRevenue) * 100).toFixed(1)) : 0;
        totalRevenue += p.salesRevenue;
        totalSalesCount += p.salesCount;
        totalUnitsSold += p.itemsSold;
        totalCogs += p.cogs;
        totalGrossProfit += p.grossProfit;
        totalInwardPurchases += p.receiptsValue;
        totalReceiptsCount += p.receiptsCount;
    }
    const averageOrderValue = totalSalesCount > 0 ? Math.round(totalRevenue / totalSalesCount) : 0;
    const grossMarginPercent = totalRevenue > 0 ? Number(((totalGrossProfit / totalRevenue) * 100).toFixed(1)) : 0;
    const netCashFlow = totalRevenue - totalInwardPurchases;
    const topProducts = Array.from(productSalesMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
    return {
        period,
        kpis: {
            totalRevenue,
            totalSalesCount,
            totalUnitsSold,
            averageOrderValue,
            totalCogs,
            totalGrossProfit,
            grossMarginPercent,
            totalInwardPurchases,
            totalReceiptsCount,
            netCashFlow,
        },
        periods,
        topProducts,
    };
}
export async function getRentalProfitabilityReport() {
    const [usages, categories, maintenanceRecords] = await Promise.all([
        InternalUsage.find({
            $or: [{ isRental: true }, { monthlyRent: { $gt: 0 } }, { lockInPeriodMonths: { $gt: 0 } }],
        })
            .populate('items.product', 'name sku brand category purchaseCost defaultSellingPrice trackingMode')
            .populate('items.serializedItemId', 'assetId serialNumber manufacturerSerial unitCost condition')
            .populate('location', 'name code')
            .sort({ createdAt: -1 })
            .lean(),
        Category.find().lean(),
        MaintenanceRecord.find().lean(),
    ]);
    const catMap = new Map();
    for (const c of categories) {
        catMap.set(c._id.toString(), c.name);
    }
    // Map maintenance cost by serializedItem ID and product ID
    const maintBySerial = new Map();
    const maintByProduct = new Map();
    for (const m of maintenanceRecords) {
        const cost = m.cost || 0;
        if (m.serializedItem) {
            const sId = m.serializedItem.toString();
            maintBySerial.set(sId, (maintBySerial.get(sId) || 0) + cost);
        }
        if (m.product) {
            const pId = m.product.toString();
            maintByProduct.set(pId, (maintByProduct.get(pId) || 0) + cost);
        }
    }
    const now = new Date();
    const items = [];
    const monthlyMap = new Map();
    let totalRentalRevenueCollected = 0;
    let totalRentalDue = 0;
    let totalScheduledRent = 0;
    let totalSecurityDepositsHeld = 0;
    let activeMRR = 0;
    let totalAssetInvestmentCost = 0;
    let totalMaintenanceExpense = 0;
    let activeRentals = 0;
    let overdueRentals = 0;
    let returnedRentals = 0;
    let capitalRecoveredCount = 0;
    for (const u of usages) {
        const isAct = u.status === USAGE_STATUSES.ACTIVE;
        const isOverdue = u.status === USAGE_STATUSES.OVERDUE ||
            (isAct && u.expectedReturnDate && new Date(u.expectedReturnDate) < now);
        const isRet = u.status === USAGE_STATUSES.RETURNED;
        if (isOverdue)
            overdueRentals++;
        else if (isAct)
            activeRentals++;
        else if (isRet)
            returnedRentals++;
        const monthlyRent = u.monthlyRent || 0;
        if (isAct) {
            activeMRR += monthlyRent;
            totalSecurityDepositsHeld += u.securityDeposit || 0;
        }
        // Identify primary item
        const primaryItem = (u.items && u.items.length > 0) ? u.items[0] : null;
        const prod = primaryItem?.product;
        const serialUnit = primaryItem?.serializedItemId;
        const productName = prod?.name || 'Instrument Rental';
        const sku = prod?.sku || 'N/A';
        const brand = prod?.brand || 'N/A';
        const categoryName = prod?.category ? (catMap.get(prod.category.toString()) || 'General Instruments') : 'General Instruments';
        const assetId = serialUnit?.assetId || serialUnit?.serialNumber || serialUnit?.manufacturerSerial;
        const serialNumber = serialUnit?.serialNumber || serialUnit?.manufacturerSerial;
        const locationName = u.location?.name || 'Central Store';
        // Purchase cost of asset
        const purchaseCost = serialUnit?.unitCost || prod?.purchaseCost || 0;
        totalAssetInvestmentCost += purchaseCost;
        // Maintenance costs
        let itemMaintCost = 0;
        if (serialUnit?._id) {
            itemMaintCost += (maintBySerial.get(serialUnit._id.toString()) || 0);
        }
        else if (prod?._id) {
            itemMaintCost += (maintByProduct.get(prod._id.toString()) || 0);
        }
        totalMaintenanceExpense += itemMaintCost;
        // Payments calculations
        const payments = u.monthlyPayments || [];
        let paidAmount = 0;
        let dueAmount = 0;
        let paidMonthsCount = 0;
        let overdueMonthsCount = 0;
        let nextPaymentDue;
        for (const p of payments) {
            paidAmount += (p.amountPaid || 0);
            const remainingForMonth = Math.max(0, (p.amountDue || 0) - (p.amountPaid || 0));
            dueAmount += remainingForMonth;
            const pDueDate = p.dueDate ? new Date(p.dueDate) : now;
            const isPastDue = pDueDate < now && remainingForMonth > 0;
            if (p.status === 'PAID' || (p.amountPaid && p.amountPaid >= p.amountDue)) {
                paidMonthsCount++;
            }
            else if (isPastDue || p.status === 'OVERDUE') {
                overdueMonthsCount++;
            }
            if (!nextPaymentDue && remainingForMonth > 0) {
                nextPaymentDue = {
                    billingMonth: p.billingMonth,
                    dueDate: pDueDate.toISOString(),
                    amountDue: remainingForMonth,
                };
            }
            // Group payments into monthly timeline
            const d = p.paidAt ? new Date(p.paidAt) : pDueDate;
            const yr = d.getFullYear();
            const mo = d.getMonth();
            const monthKey = `${yr}-${String(mo + 1).padStart(2, '0')}`;
            const monthLabel = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
            const existingMonthly = monthlyMap.get(monthKey) || {
                label: monthLabel,
                collected: 0,
                due: 0,
                maintenance: 0,
                sortKey: yr * 100 + mo,
            };
            existingMonthly.collected += (p.amountPaid || 0);
            existingMonthly.due += remainingForMonth;
            monthlyMap.set(monthKey, existingMonthly);
        }
        if (payments.length === 0) {
            paidAmount = u.totalRentPaid || 0;
            dueAmount = u.totalRentDue || 0;
        }
        totalRentalRevenueCollected += paidAmount;
        totalRentalDue += dueAmount;
        const itemScheduledRent = paidAmount + dueAmount;
        totalScheduledRent += itemScheduledRent;
        const netProfit = paidAmount - itemMaintCost;
        const roiPercent = purchaseCost > 0 ? Number(((paidAmount / purchaseCost) * 100).toFixed(1)) : 100;
        const recoveryPercent = purchaseCost > 0 ? Math.min(250, Number(((paidAmount / purchaseCost) * 100).toFixed(1))) : 100;
        const isCapexRecovered = paidAmount >= purchaseCost && purchaseCost > 0;
        if (isCapexRecovered) {
            capitalRecoveredCount++;
        }
        items.push({
            id: u._id.toString(),
            issueReference: u.issueReference,
            customerName: u.assignedPerson,
            customerContact: u.assignedPersonContact,
            customerEmail: u.customerEmail,
            productName,
            sku,
            brand,
            category: categoryName,
            serializedItemId: serialUnit?._id?.toString(),
            assetId,
            serialNumber,
            locationName,
            issueDate: u.issueDate ? new Date(u.issueDate).toISOString() : new Date().toISOString(),
            expectedReturnDate: u.expectedReturnDate ? new Date(u.expectedReturnDate).toISOString() : new Date().toISOString(),
            actualReturnDate: u.actualReturnDate ? new Date(u.actualReturnDate).toISOString() : undefined,
            status: isOverdue ? 'OVERDUE' : (isRet ? 'RETURNED' : 'ACTIVE'),
            isRental: u.isRental !== false,
            lockInPeriodMonths: u.lockInPeriodMonths || 3,
            monthlyRent,
            securityDeposit: u.securityDeposit || 0,
            totalRentPaid: paidAmount,
            totalRentDue: dueAmount,
            totalScheduledRent: itemScheduledRent,
            purchaseCost,
            maintenanceCost: itemMaintCost,
            netProfit,
            roiPercent,
            isCapexRecovered,
            recoveryPercent,
            accessories: u.includedAccessories || [],
            paymentsCount: payments.length,
            paidMonthsCount,
            overdueMonthsCount,
            nextPaymentDue,
            monthlyPayments: payments.map((p) => ({
                monthIndex: p.monthIndex,
                billingMonth: p.billingMonth,
                dueDate: p.dueDate ? new Date(p.dueDate).toISOString() : '',
                amountDue: p.amountDue,
                amountPaid: p.amountPaid,
                paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : undefined,
                paymentMethod: p.paymentMethod,
                transactionRef: p.transactionRef,
                status: p.status,
                notes: p.notes,
            })),
        });
    }
    // Monthly timeline array sorted chronologically
    const monthlyCashflow = Array.from(monthlyMap.entries())
        .sort((a, b) => a[1].sortKey - b[1].sortKey)
        .slice(-12) // Last 12 months
        .map(([monthKey, val]) => ({
        monthKey,
        label: val.label,
        collected: val.collected,
        due: val.due,
        maintenance: val.maintenance,
        netProfit: val.collected - val.maintenance,
    }));
    // Category performance aggregation
    const catGroup = new Map();
    for (const item of items) {
        const c = item.category || 'Other';
        const existing = catGroup.get(c) || {
            category: c,
            rentalsCount: 0,
            totalCollected: 0,
            totalCapex: 0,
            maintenanceCost: 0,
        };
        existing.rentalsCount++;
        existing.totalCollected += item.totalRentPaid;
        existing.totalCapex += item.purchaseCost;
        existing.maintenanceCost += item.maintenanceCost;
        catGroup.set(c, existing);
    }
    const categoryPerformance = Array.from(catGroup.values()).map((cg) => ({
        ...cg,
        netProfit: cg.totalCollected - cg.maintenanceCost,
        roiPercent: cg.totalCapex > 0 ? Number(((cg.totalCollected / cg.totalCapex) * 100).toFixed(1)) : 100,
    }));
    const totalRentals = items.length;
    const netRentalProfit = totalRentalRevenueCollected - totalMaintenanceExpense;
    const portfolioRoiPercent = totalAssetInvestmentCost > 0
        ? Number(((totalRentalRevenueCollected / totalAssetInvestmentCost) * 100).toFixed(1))
        : 0;
    const collectionRatePercent = totalScheduledRent > 0
        ? Math.round((totalRentalRevenueCollected / totalScheduledRent) * 100)
        : 100;
    const projectedARR = activeMRR * 12;
    return {
        kpis: {
            totalRentals,
            activeRentals,
            overdueRentals,
            returnedRentals,
            totalRentalRevenueCollected,
            totalRentalDue,
            totalScheduledRent,
            collectionRatePercent,
            totalSecurityDepositsHeld,
            activeMRR,
            projectedARR,
            totalAssetInvestmentCost,
            totalMaintenanceExpense,
            netRentalProfit,
            portfolioRoiPercent,
            capitalRecoveredCount,
        },
        monthlyCashflow,
        categoryPerformance,
        items,
    };
}
