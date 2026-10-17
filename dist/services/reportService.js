import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { Sale } from '../models/Sale.js';
import { PurchaseReceipt } from '../models/PurchaseReceipt.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { StockMovement } from '../models/StockMovement.js';
import '../models/User.js';
import '../models/StockLocation.js';
import { SERIALIZED_STATUSES, USAGE_STATUSES, ADJUSTMENT_STATUSES, TRACKING_MODES, } from '../config/constants.js';
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
            // Find current day of week (0=Sun, 1=Mon... 6=Sat)
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
                receiptsCount: 0,
                receiptsValue: 0,
                adjustmentsCount: 0,
            });
        }
    }
    const overallStart = new Date(periods[0].startDate);
    const overallEnd = new Date(periods[periods.length - 1].endDate);
    const [sales, receipts, adjustments] = await Promise.all([
        Sale.find({ createdAt: { $gte: overallStart, $lte: overallEnd } }).populate('lineItems.product', 'name sku').lean(),
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
        const itemsQty = (s.lineItems || []).reduce((sum, li) => sum + (li.quantity || 0), 0);
        if (bucket) {
            bucket.salesCount++;
            bucket.salesRevenue += s.grandTotal || 0;
            bucket.itemsSold += itemsQty;
        }
        for (const li of (s.lineItems || [])) {
            const prod = li.product;
            if (prod && prod._id) {
                const id = prod._id.toString();
                const existing = productSalesMap.get(id) || {
                    name: prod.name || 'Product',
                    sku: prod.sku || '',
                    quantity: 0,
                    revenue: 0,
                };
                existing.quantity += li.quantity || 0;
                existing.revenue += li.total || 0;
                productSalesMap.set(id, existing);
            }
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
    let totalInwardPurchases = 0;
    let totalReceiptsCount = 0;
    for (const p of periods) {
        totalRevenue += p.salesRevenue;
        totalSalesCount += p.salesCount;
        totalUnitsSold += p.itemsSold;
        totalInwardPurchases += p.receiptsValue;
        totalReceiptsCount += p.receiptsCount;
    }
    const averageOrderValue = totalSalesCount > 0 ? Math.round(totalRevenue / totalSalesCount) : 0;
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
            totalInwardPurchases,
            totalReceiptsCount,
        },
        periods,
        topProducts,
    };
}
