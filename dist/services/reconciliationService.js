import { Product } from '../models/Product.js';
import { StockMovement } from '../models/StockMovement.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { TRACKING_MODES, SERIALIZED_STATUSES } from '../config/constants.js';
export async function runInventoryReconciliation() {
    const products = await Product.find({ isActive: true }).lean();
    const results = [];
    let mismatchesFound = 0;
    for (const product of products) {
        const recordedOnHand = product.stockQuantity?.onHand || 0;
        // Sum all movements from ledger
        const movementSumResult = await StockMovement.aggregate([
            { $match: { product: product._id } },
            { $group: { _id: null, totalDelta: { $sum: '$quantityDelta' } } },
        ]);
        const calculatedFromLedger = movementSumResult.length > 0 ? movementSumResult[0].totalDelta : 0;
        let serializedCount;
        if (product.trackingMode === TRACKING_MODES.SERIALIZED) {
            // Physical count of owned units: not SOLD and not RETIRED
            serializedCount = await SerializedItem.countDocuments({
                product: product._id,
                status: { $nin: [SERIALIZED_STATUSES.SOLD, SERIALIZED_STATUSES.RETIRED] },
            });
        }
        const ledgerMismatch = recordedOnHand !== calculatedFromLedger;
        const serializedMismatch = serializedCount !== undefined && serializedCount !== recordedOnHand;
        const hasMismatch = ledgerMismatch || serializedMismatch;
        if (hasMismatch) {
            mismatchesFound++;
        }
        results.push({
            productId: product._id.toString(),
            productName: product.name,
            sku: product.sku,
            trackingMode: product.trackingMode,
            recordedOnHand,
            calculatedFromLedger,
            serializedPhysicalCount: serializedCount,
            discrepancyDelta: recordedOnHand - calculatedFromLedger,
            hasMismatch,
        });
    }
    return {
        timestamp: new Date(),
        totalProductsChecked: products.length,
        mismatchesFound,
        results,
    };
}
