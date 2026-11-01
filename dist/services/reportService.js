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
import { SERIALIZED_STATUSES, USAGE_STATUSES, MAINTENANCE_STATUSES, ADJUSTMENT_STATUSES, TRACKING_MODES, SALE_STATUSES, } from '../config/constants.js';
export function calcMetricDelta(current, previous) {
    if (previous === 0) {
        if (current === 0)
            return { deltaPercent: 0, direction: 'neutral' };
        return { deltaPercent: 100, direction: 'up' };
    }
    const pct = Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
    return {
        deltaPercent: Math.abs(pct),
        direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral',
    };
}
export async function getDashboardMetrics(startDate, endDate) {
    const now = new Date();
    // Determine current period bounds (defaults to This Month if not passed)
    const currentEnd = endDate ? new Date(endDate) : new Date();
    let currentStart;
    if (startDate) {
        currentStart = new Date(startDate);
    }
    else {
        currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }
    // Calculate equivalent previous period bounds for accurate comparisons
    const durationMs = currentEnd.getTime() - currentStart.getTime();
    const prevEnd = new Date(currentStart.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - durationMs);
    const start = currentStart;
    const end = currentEnd;
    // 1. Parallel database queries across all required operational and financial models
    const [products, serializedSummary, allSales, allEmiSales, allRentals, allMaintenanceRecords, periodReceipts, allReceipts, inventoryMovements, pendingApprovalsCount, recentMovements,] = await Promise.all([
        Product.find({ isActive: true })
            .select('name sku brand category trackingMode purchaseCost defaultSellingPrice minStockThreshold stockQuantity locationStock updatedAt')
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
        Sale.find({ saleStatus: { $ne: 'CANCELLED' } })
            .populate('lineItems.product', 'name sku purchaseCost defaultSellingPrice')
            .lean(),
        Sale.find({ isEmi: true, saleStatus: { $nin: ['CANCELLED', 'RETURNED'] } })
            .populate('lineItems.product', 'name sku purchaseCost')
            .lean(),
        InternalUsage.find({ isRental: true })
            .populate('items.product', 'name sku brand purchaseCost')
            .populate('items.serializedItemId', 'assetId manufacturerSerial unitCost')
            .lean(),
        MaintenanceRecord.find().lean(),
        PurchaseReceipt.find({ receivedDate: { $gte: start, $lte: end } }).lean(),
        PurchaseReceipt.find().lean(),
        StockMovement.find().sort({ createdAt: -1 }).limit(100).lean(),
        InventoryAdjustment.countDocuments({ status: ADJUSTMENT_STATUSES.PENDING_APPROVAL }),
        StockMovement.find()
            .populate('product', 'name sku brand color')
            .populate('serializedItem', 'assetId')
            .populate('performedBy', 'name role')
            .populate('location', 'name code')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
    ]);
    // Index serialized aggregation by productId string
    const serializedMap = new Map();
    for (const s of serializedSummary) {
        if (s._id) {
            serializedMap.set(s._id.toString(), { count: s.count, totalCost: s.totalCost });
        }
    }
    // ── 2. Sales & Revenue Calculations (Current vs. Previous Period) ───────────
    const currentSales = allSales.filter((s) => {
        const d = new Date(s.createdAt);
        return d >= start && d <= end && s.saleStatus !== 'RETURNED';
    });
    const prevSales = allSales.filter((s) => {
        const d = new Date(s.createdAt);
        return d >= prevStart && d <= prevEnd && s.saleStatus !== 'RETURNED';
    });
    // Sales Revenue (recognized from confirmed sales, excluding cancellations and returns)
    const currentSalesRevenue = currentSales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    const prevSalesRevenue = prevSales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    // COGS for confirmed sales
    let currentCOGS = 0;
    for (const s of currentSales) {
        for (const li of s.lineItems || []) {
            const prod = li.product;
            const unitCost = prod?.purchaseCost || 0;
            currentCOGS += (li.quantity || 1) * unitCost;
        }
    }
    let prevCOGS = 0;
    for (const s of prevSales) {
        for (const li of s.lineItems || []) {
            const prod = li.product;
            const unitCost = prod?.purchaseCost || 0;
            prevCOGS += (li.quantity || 1) * unitCost;
        }
    }
    // Gross Profit
    const currentGrossProfit = currentSalesRevenue - currentCOGS;
    const prevGrossProfit = prevSalesRevenue - prevCOGS;
    const currentGrossMarginPct = currentSalesRevenue > 0 ? Number(((currentGrossProfit / currentSalesRevenue) * 100).toFixed(1)) : 0;
    const prevGrossMarginPct = prevSalesRevenue > 0 ? Number(((prevGrossProfit / prevSalesRevenue) * 100).toFixed(1)) : 0;
    // ── 3. Actual Cash Collected (Current vs. Previous Period) ───────────────────
    // (A) Direct Sales Collections
    const currDirectCash = currentSales
        .filter((s) => !s.isEmi && s.paymentStatus === 'PAID')
        .reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    const prevDirectCash = prevSales
        .filter((s) => !s.isEmi && s.paymentStatus === 'PAID')
        .reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    // (B) EMI Down Payments & Installments Collected
    const currEmiDownPayments = currentSales
        .filter((s) => s.isEmi)
        .reduce((sum, s) => sum + (s.downPayment || 0), 0);
    const prevEmiDownPayments = prevSales
        .filter((s) => s.isEmi)
        .reduce((sum, s) => sum + (s.downPayment || 0), 0);
    let currEmiInstallments = 0;
    let prevEmiInstallments = 0;
    for (const s of allEmiSales) {
        for (const p of s.emiPayments || []) {
            const pDate = p.paidAt ? new Date(p.paidAt) : (p.status === 'PAID' ? new Date(p.dueDate) : null);
            if (pDate) {
                if (pDate >= start && pDate <= end && (p.amountPaid || 0) > 0) {
                    currEmiInstallments += p.amountPaid;
                }
                else if (pDate >= prevStart && pDate <= prevEnd && (p.amountPaid || 0) > 0) {
                    prevEmiInstallments += p.amountPaid;
                }
            }
        }
    }
    // (C) Rental Collections
    let currRentalIncome = 0;
    let prevRentalIncome = 0;
    let allTimeRentalCollected = 0;
    let totalRentalDue = 0;
    let totalRentalOverdue = 0;
    let overdueRentalAgreementsCount = 0;
    let totalSecurityDepositsHeld = 0;
    let depositsAvailableForDeduction = 0;
    let pendingRefundsTotal = 0;
    let pendingRefundsCount = 0;
    let approachingDeadlinesCount = 0;
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    for (const u of allRentals) {
        const isAct = u.status === USAGE_STATUSES.ACTIVE || u.status === USAGE_STATUSES.OVERDUE || u.status === USAGE_STATUSES.PARTIALLY_RETURNED;
        const isRet = u.status === USAGE_STATUSES.RETURNED;
        if (isAct) {
            totalSecurityDepositsHeld += (u.depositBalance ?? u.securityDeposit ?? 0);
            if (u.depositMode && (u.depositBalance ?? 0) > 0) {
                depositsAvailableForDeduction += u.depositBalance;
            }
            if (u.expectedReturnDate && new Date(u.expectedReturnDate) <= thirtyDaysFromNow && new Date(u.expectedReturnDate) >= now) {
                approachingDeadlinesCount++;
            }
        }
        else if (isRet) {
            const remainingDep = u.depositBalance ?? 0;
            if (remainingDep > 0) {
                pendingRefundsTotal += remainingDep;
                pendingRefundsCount++;
            }
        }
        let agreementOverdue = false;
        for (const p of u.monthlyPayments || []) {
            const pDate = p.paidAt ? new Date(p.paidAt) : (p.status === 'PAID' ? new Date(p.dueDate) : null);
            if (pDate) {
                if (pDate >= start && pDate <= end && (p.amountPaid || 0) > 0) {
                    currRentalIncome += p.amountPaid;
                }
                else if (pDate >= prevStart && pDate <= prevEnd && (p.amountPaid || 0) > 0) {
                    prevRentalIncome += p.amountPaid;
                }
            }
            allTimeRentalCollected += (p.amountPaid || 0);
            const remainingMonthDue = Math.max(0, (p.amountDue || 0) - (p.amountPaid || 0));
            if (remainingMonthDue > 0) {
                totalRentalDue += remainingMonthDue;
                const pDueDate = p.dueDate ? new Date(p.dueDate) : now;
                if (pDueDate < now) {
                    totalRentalOverdue += remainingMonthDue;
                    agreementOverdue = true;
                }
            }
        }
        if (agreementOverdue) {
            overdueRentalAgreementsCount++;
        }
    }
    // Fallback if payments array was empty but totalRentPaid is logged
    if (currRentalIncome === 0 && start.getTime() === 0) {
        currRentalIncome = allRentals.reduce((sum, u) => sum + (u.totalRentPaid || 0), 0);
    }
    const currentCashCollected = currDirectCash + currEmiDownPayments + currEmiInstallments + currRentalIncome;
    const prevCashCollected = prevDirectCash + prevEmiDownPayments + prevEmiInstallments + prevRentalIncome;
    // ── 4. Outstanding Receivables ──────────────────────────────────────────────
    const totalEmiReceivables = allEmiSales.reduce((sum, s) => sum + (s.totalEmiDue || 0), 0);
    const totalOutstandingReceivables = totalEmiReceivables + totalRentalDue;
    // Overdue EMI calculation
    let overdueEmiAmount = 0;
    let overdueEmiCount = 0;
    for (const s of allEmiSales) {
        let saleHasOverdue = false;
        for (const p of s.emiPayments || []) {
            const unpaid = Math.max(0, (p.amountDue || 0) - (p.amountPaid || 0));
            if (unpaid > 0 && p.dueDate && new Date(p.dueDate) < now) {
                overdueEmiAmount += unpaid;
                saleHasOverdue = true;
            }
        }
        if (saleHasOverdue)
            overdueEmiCount++;
    }
    // ── 5. Net Rental Profit & Fleet Performance ────────────────────────────────
    const currMaintRecords = allMaintenanceRecords.filter((m) => {
        const d = m.completedAt ? new Date(m.completedAt) : new Date(m.startedAt);
        return d >= start && d <= end && m.status === MAINTENANCE_STATUSES.COMPLETED;
    });
    const prevMaintRecords = allMaintenanceRecords.filter((m) => {
        const d = m.completedAt ? new Date(m.completedAt) : new Date(m.startedAt);
        return d >= prevStart && d <= prevEnd && m.status === MAINTENANCE_STATUSES.COMPLETED;
    });
    const currMaintenanceExpense = currMaintRecords.reduce((sum, m) => sum + (m.cost || 0), 0);
    const prevMaintenanceExpense = prevMaintRecords.reduce((sum, m) => sum + (m.cost || 0), 0);
    const allTimeMaintenanceExpense = allMaintenanceRecords.reduce((sum, m) => sum + (m.cost || 0), 0);
    const currentNetRentalProfit = currRentalIncome - currMaintenanceExpense;
    const prevNetRentalProfit = prevRentalIncome - prevMaintenanceExpense;
    // Fleet acquisition capex & capital recovery
    let totalFleetCapex = 0;
    let unrecoveredCapexCount = 0;
    for (const u of allRentals) {
        for (const it of u.items || []) {
            const ser = it.serializedItemId;
            const prod = it.product;
            const cost = ser?.unitCost || prod?.purchaseCost || 0;
            totalFleetCapex += cost;
            if ((u.totalRentPaid || 0) < cost) {
                unrecoveredCapexCount++;
            }
        }
    }
    const allTimeNetRentalProfit = allTimeRentalCollected - allTimeMaintenanceExpense;
    const fleetCapexRecoveryPercent = totalFleetCapex > 0 ? Number(((allTimeNetRentalProfit / totalFleetCapex) * 100).toFixed(1)) : 100;
    // ── 6. Inventory Valuation & Stock Health ───────────────────────────────────
    let totalUnitsOnHand = 0;
    let totalAvailableForSale = 0;
    let totalUnitsInRental = 0;
    let totalUnitsInMaintenance = 0;
    let totalUnitsReserved = 0;
    let totalInventoryValuationAtCost = 0;
    let totalPotentialRetailValuation = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const lowStockItems = [];
    const slowMovingItems = [];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (const p of products) {
        const sq = p.stockQuantity || { onHand: 0, reserved: 0, issuedInternal: 0, quarantined: 0 };
        let onHand = sq.onHand || 0;
        const serData = serializedMap.get(p._id.toString());
        if (p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.count > 0) {
            onHand = Math.max(onHand, serData.count);
        }
        const available = Math.max(0, onHand - (sq.reserved || 0) - (sq.issuedInternal || 0) - (sq.quarantined || 0));
        totalUnitsOnHand += onHand;
        totalAvailableForSale += available;
        totalUnitsInRental += (sq.issuedInternal || 0);
        totalUnitsInMaintenance += (sq.quarantined || 0);
        totalUnitsReserved += (sq.reserved || 0);
        const costVal = p.trackingMode === TRACKING_MODES.SERIALIZED && serData && serData.totalCost > 0
            ? serData.totalCost
            : onHand * (p.purchaseCost || 0);
        totalInventoryValuationAtCost += costVal;
        totalPotentialRetailValuation += onHand * (p.defaultSellingPrice || 0);
        if (available === 0) {
            outOfStockCount++;
            lowStockItems.push({ name: p.name, sku: p.sku, available: 0, threshold: p.minStockThreshold || 5 });
        }
        else if (available <= (p.minStockThreshold || 5)) {
            lowStockCount++;
            lowStockItems.push({ name: p.name, sku: p.sku, available, threshold: p.minStockThreshold || 5 });
        }
        // Slow moving check: product updated before 30 days and no recent sales
        const lastActive = p.updatedAt ? new Date(p.updatedAt) : thirtyDaysAgo;
        if (lastActive < thirtyDaysAgo && onHand > 0) {
            slowMovingItems.push({ name: p.name, sku: p.sku, onHand, costValue: costVal });
        }
    }
    // Active units on rent from InternalUsage items (reconciled)
    let activeRentalsItemsCount = 0;
    for (const u of allRentals) {
        if (u.status === USAGE_STATUSES.ACTIVE || u.status === USAGE_STATUSES.OVERDUE || u.status === USAGE_STATUSES.PARTIALLY_RETURNED) {
            for (const item of u.items || []) {
                activeRentalsItemsCount += Math.max(0, (item.quantityIssued || 0) - (item.quantityReturned || 0));
            }
        }
    }
    const serializedInUseCount = Math.max(activeRentalsItemsCount, totalUnitsInRental);
    const potentialGrossMargin = totalPotentialRetailValuation - totalInventoryValuationAtCost;
    const potentialMarginPercent = totalPotentialRetailValuation > 0
        ? Number(((potentialGrossMargin / totalPotentialRetailValuation) * 100).toFixed(1))
        : 0;
    // ── 7. Financial Health & Net Cash Movement ─────────────────────────────────
    const inwardReceiptsValue = periodReceipts.reduce((sum, r) => {
        const itemsVal = (r.lineItems || []).reduce((iSum, it) => iSum + (it.quantityReceived || 0) * (it.unitCost || 0), 0);
        return sum + itemsVal;
    }, 0);
    const cashInflows = currentCashCollected;
    const cashOutflows = inwardReceiptsValue + currMaintenanceExpense;
    const netCashMovement = cashInflows - cashOutflows;
    // ── 8. Overdue Equipment Returns ───────────────────────────────────────────
    let overdueReturnsCount = 0;
    let overdueReturnsAssetValue = 0;
    for (const u of allRentals) {
        const isAct = u.status === USAGE_STATUSES.ACTIVE || u.status === USAGE_STATUSES.OVERDUE || u.status === USAGE_STATUSES.PARTIALLY_RETURNED;
        if (isAct && u.expectedReturnDate && new Date(u.expectedReturnDate) < now) {
            overdueReturnsCount++;
            for (const it of u.items || []) {
                const ser = it.serializedItemId;
                const prod = it.product;
                overdueReturnsAssetValue += ser?.unitCost || prod?.purchaseCost || 0;
            }
        }
    }
    // ── 9. Prioritized Business Alerts ("Needs Attention") ──────────────────────
    const businessAlerts = [];
    if (overdueEmiCount > 0) {
        businessAlerts.push({
            id: 'alert-overdue-emi',
            title: 'Overdue EMI Installments',
            message: `${overdueEmiCount} customer EMI plan(s) have overdue payments totaling ₹${overdueEmiAmount.toLocaleString('en-IN')}`,
            severity: 'critical',
            category: 'FINANCIAL',
            affectedCount: overdueEmiCount,
            financialExposure: overdueEmiAmount,
            deepLink: '/sales',
            actionText: 'Review EMI Dues',
        });
    }
    if (overdueRentalAgreementsCount > 0) {
        businessAlerts.push({
            id: 'alert-overdue-rent',
            title: 'Overdue Rental Payments',
            message: `${overdueRentalAgreementsCount} rental agreement(s) have overdue payments totaling ₹${totalRentalOverdue.toLocaleString('en-IN')}`,
            severity: 'critical',
            category: 'RENTAL',
            affectedCount: overdueRentalAgreementsCount,
            financialExposure: totalRentalOverdue,
            deepLink: '/usage',
            actionText: 'Collect Rent',
        });
    }
    if (overdueReturnsCount > 0) {
        businessAlerts.push({
            id: 'alert-overdue-returns',
            title: 'Overdue Instrument Returns',
            message: `${overdueReturnsCount} rental instrument(s) are past their return deadline with ₹${overdueReturnsAssetValue.toLocaleString('en-IN')} in capital exposure`,
            severity: 'high',
            category: 'RENTAL',
            affectedCount: overdueReturnsCount,
            financialExposure: overdueReturnsAssetValue,
            deepLink: '/usage',
            actionText: 'Track Returns',
        });
    }
    if (pendingRefundsCount > 0) {
        businessAlerts.push({
            id: 'alert-pending-refunds',
            title: 'Customer Deposit Refunds Payable',
            message: `${pendingRefundsCount} returned rental(s) have pending deposit refunds totaling ₹${pendingRefundsTotal.toLocaleString('en-IN')}`,
            severity: 'medium',
            category: 'FINANCIAL',
            affectedCount: pendingRefundsCount,
            financialExposure: pendingRefundsTotal,
            deepLink: '/usage',
            actionText: 'Disburse Refunds',
        });
    }
    if (outOfStockCount > 0 || lowStockCount > 0) {
        businessAlerts.push({
            id: 'alert-stock-buffer',
            title: 'Low Stock & Stockout Warning',
            message: `${outOfStockCount} product(s) out of stock and ${lowStockCount} below minimum safety buffer`,
            severity: 'medium',
            category: 'INVENTORY',
            affectedCount: outOfStockCount + lowStockCount,
            financialExposure: 0,
            deepLink: '/inventory',
            actionText: 'Restock Inventory',
        });
    }
    const activeMaintenanceCount = allMaintenanceRecords.filter((m) => m.status === MAINTENANCE_STATUSES.IN_PROGRESS || m.status === MAINTENANCE_STATUSES.WAITING_PARTS).length;
    if (activeMaintenanceCount > 0) {
        businessAlerts.push({
            id: 'alert-maintenance',
            title: 'Instruments Under Maintenance',
            message: `${activeMaintenanceCount} asset(s) are currently undergoing repairs or awaiting spare parts`,
            severity: 'low',
            category: 'OPERATIONAL',
            affectedCount: activeMaintenanceCount,
            financialExposure: currMaintenanceExpense,
            deepLink: '/returns-maintenance',
            actionText: 'View Workshop',
        });
    }
    // ── 10. Executive Trends (Daily Timeline) ───────────────────────────────────
    const daysInPeriod = Math.max(1, Math.min(30, Math.ceil(durationMs / (24 * 60 * 60 * 1000))));
    const dailyTimeline = [];
    const trendStart = new Date(end);
    trendStart.setDate(trendStart.getDate() - (daysInPeriod - 1));
    trendStart.setHours(0, 0, 0, 0);
    for (let i = 0; i < daysInPeriod; i++) {
        const curD = new Date(trendStart);
        curD.setDate(trendStart.getDate() + i);
        const dayKey = curD.toISOString().slice(0, 10);
        const dayLabel = curD.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
        const daySales = currentSales.filter((s) => new Date(s.createdAt).toISOString().slice(0, 10) === dayKey);
        const dayRev = daySales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
        let dayCogs = 0;
        for (const s of daySales) {
            for (const li of s.lineItems || []) {
                const prod = li.product;
                dayCogs += (li.quantity || 1) * (prod?.purchaseCost || 0);
            }
        }
        const dayDirectCash = daySales.filter((s) => !s.isEmi && s.paymentStatus === 'PAID').reduce((sum, s) => sum + (s.grandTotal || 0), 0);
        const dayEmiDown = daySales.filter((s) => s.isEmi).reduce((sum, s) => sum + (s.downPayment || 0), 0);
        // Rental collections for that day
        let dayRentalCash = 0;
        for (const u of allRentals) {
            for (const p of u.monthlyPayments || []) {
                if (p.paidAt && new Date(p.paidAt).toISOString().slice(0, 10) === dayKey) {
                    dayRentalCash += (p.amountPaid || 0);
                }
            }
        }
        const dayCollections = dayDirectCash + dayEmiDown + dayRentalCash;
        dailyTimeline.push({
            date: dayKey,
            label: dayLabel,
            salesRevenue: dayRev,
            cashCollected: dayCollections,
            grossProfit: Math.max(0, dayRev - dayCogs),
            rentalCollections: dayRentalCash,
            rentalDue: totalRentalDue > 0 ? Math.round(totalRentalDue / daysInPeriod) : 0,
        });
    }
    // ── 11. Compose Structured Response ─────────────────────────────────────────
    const deltaRev = calcMetricDelta(currentSalesRevenue, prevSalesRevenue);
    const deltaCash = calcMetricDelta(currentCashCollected, prevCashCollected);
    const deltaProfit = calcMetricDelta(currentGrossProfit, prevGrossProfit);
    const deltaRent = calcMetricDelta(currentNetRentalProfit, prevNetRentalProfit);
    return {
        reportingPeriod: {
            current: {
                startDate: currentStart.toISOString(),
                endDate: currentEnd.toISOString(),
                label: `${currentStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} – ${currentEnd.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}`,
            },
            previous: {
                startDate: prevStart.toISOString(),
                endDate: prevEnd.toISOString(),
                label: `${prevStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} – ${prevEnd.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}`,
            },
        },
        // 1. Primary Executive Financials (The CEO's Core Question Cards)
        executiveFinancials: {
            salesRevenue: {
                value: currentSalesRevenue,
                previousValue: prevSalesRevenue,
                deltaPercent: deltaRev.deltaPercent,
                direction: deltaRev.direction,
                definition: 'Recognized net revenue from confirmed sales transactions, excluding cancelled orders and customer returns.',
                isAvailable: true,
            },
            cashCollected: {
                value: currentCashCollected,
                previousValue: prevCashCollected,
                deltaPercent: deltaCash.deltaPercent,
                direction: deltaCash.direction,
                definition: 'Actual liquid funds received across direct POS sales, EMI installments, down payments, and rental income.',
                isAvailable: true,
            },
            grossProfit: {
                value: currentGrossProfit,
                previousValue: prevGrossProfit,
                deltaPercent: deltaProfit.deltaPercent,
                direction: deltaProfit.direction,
                marginPercent: currentGrossMarginPct,
                previousMarginPercent: prevGrossMarginPct,
                definition: 'Recognized sales revenue minus cost of goods sold (COGS) based on inventory purchase cost.',
                isAvailable: true,
            },
            outstandingReceivables: {
                value: totalOutstandingReceivables,
                previousValue: totalOutstandingReceivables,
                deltaPercent: 0,
                direction: 'neutral',
                emiReceivables: totalEmiReceivables,
                rentalReceivables: totalRentalDue,
                definition: 'Total outstanding credit balances owed by customers, including pending EMI installments and unpaid rental dues.',
                isAvailable: true,
            },
            inventoryValuationAtCost: {
                value: totalInventoryValuationAtCost,
                previousValue: totalInventoryValuationAtCost,
                deltaPercent: 0,
                direction: 'neutral',
                potentialRetailValue: totalPotentialRetailValuation,
                potentialMargin: potentialGrossMargin,
                marginPercent: potentialMarginPercent,
                definition: 'Current valuation of all company-owned inventory at purchase cost across available, rented, and maintenance units.',
                isAvailable: true,
            },
            netRentalProfit: {
                value: currentNetRentalProfit,
                previousValue: prevNetRentalProfit,
                deltaPercent: deltaRent.deltaPercent,
                direction: deltaRent.direction,
                rentalRevenue: currRentalIncome,
                maintenanceExpenses: currMaintenanceExpense,
                allTimeProfit: allTimeNetRentalProfit,
                capexRecoveryPercent: fleetCapexRecoveryPercent,
                definition: 'Rental income collected during the period minus attributable instrument maintenance and servicing expenses.',
                isAvailable: true,
            },
        },
        // 2. Financial Health & Net Cash Movement
        financialHealth: {
            cashInflows,
            cashOutflows,
            netCashMovement,
            directSalesCash: currDirectCash,
            emiCollections: currEmiDownPayments + currEmiInstallments,
            rentalCollections: currRentalIncome,
            inventoryPurchases: inwardReceiptsValue,
            maintenanceExpenses: currMaintenanceExpense,
            customerDepositsHeld: totalSecurityDepositsHeld,
            refundsPayable: pendingRefundsTotal,
            outstandingEmiReceivables: totalEmiReceivables,
            outstandingRentalReceivables: totalRentalDue,
        },
        // 3. Inventory & Asset Health (4-Part Stock Reconciliation)
        inventoryHealth: {
            totalUnitsOwned: totalUnitsOnHand,
            totalAvailableForSale,
            totalUnitsInRental: serializedInUseCount,
            totalUnitsInMaintenance: Math.max(activeMaintenanceCount, totalUnitsInMaintenance),
            totalUnitsReserved,
            totalInventoryValuationAtCost,
            totalPotentialRetailValuation,
            potentialGrossMargin,
            potentialMarginPercent,
            lowStockCount,
            outOfStockCount,
            slowMovingCount: slowMovingItems.length,
            lowStockItems: lowStockItems.slice(0, 5),
            slowMovingItems: slowMovingItems.slice(0, 5),
        },
        // 4. Rental Business Performance
        rentalPerformance: {
            activeAgreements: allRentals.filter((u) => u.status === USAGE_STATUSES.ACTIVE || u.status === USAGE_STATUSES.OVERDUE).length,
            instrumentsOnRent: serializedInUseCount,
            rentalIncomeCollected: currRentalIncome,
            allTimeRentalCollected,
            totalRentalDue,
            totalRentalOverdue,
            overdueAgreementsCount: overdueRentalAgreementsCount,
            totalSecurityDepositsHeld,
            depositsAvailableForDeduction,
            pendingRefundsTotal,
            pendingRefundsCount,
            approachingDeadlinesCount,
            totalFleetCapex,
            allTimeNetRentalProfit,
            fleetCapexRecoveryPercent,
            unrecoveredCapexCount,
        },
        // 5. Prioritized Business Alerts
        businessAlerts,
        // 6. Executive Trend Charts
        executiveTrends: {
            dailyTimeline,
        },
        // Backward compatible raw KPIs for legacy widgets
        kpis: {
            totalUnitsOnHand,
            totalAvailableForSale,
            distinctProductCount: products.length,
            serializedInUseCount,
            lowStockCount,
            activeUsageCount: allRentals.filter((u) => u.status === USAGE_STATUSES.ACTIVE).length,
            overdueUsageCount: overdueReturnsCount,
            instrumentsUnderMaintenanceCount: Math.max(activeMaintenanceCount, totalUnitsInMaintenance),
            todayReceiptsCount: periodReceipts.length,
            periodSalesCount: currentSales.length,
            periodSalesRevenue: currentSalesRevenue,
            pendingApprovalsCount,
            totalInventoryValuationAtCost,
            totalPotentialRetailValuation,
            activeEmiSalesCount: allEmiSales.length,
            totalEmiReceivables,
            currentCashCollected,
            currentGrossProfit,
            currentGrossMarginPct,
            currentNetRentalProfit,
            totalOutstandingReceivables,
            netCashMovement,
        },
        recentMovements,
        salesTrend: dailyTimeline.map((d) => ({ _id: d.date, revenue: d.salesRevenue, count: 1 })),
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
