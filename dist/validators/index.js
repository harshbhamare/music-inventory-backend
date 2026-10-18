import { z } from 'zod';
import { TRACKING_MODES, ITEM_CONDITIONS, USAGE_PURPOSES, PAYMENT_METHODS, } from '../config/constants.js';
// Auth
export const loginSchema = z.object({
    body: z.object({
        email: z.string().email('Valid email is required'),
        password: z.string().min(6, 'Password must be at least 6 characters'),
    }),
});
export const createUserSchema = z.object({
    body: z.object({
        name: z.string().min(2, 'Name must be at least 2 characters'),
        email: z.string().email('Valid email is required'),
        password: z.string().min(6, 'Password must be at least 6 characters'),
        role: z.enum(['SUPER_ADMIN', 'MANAGER']),
    }),
});
// Products
export const createProductSchema = z.object({
    body: z.object({
        name: z.string().min(2, 'Product name is required'),
        sku: z.string().optional(),
        color: z.string().optional(),
        hsnCode: z.string().optional().default('9202'),
        category: z.string().min(1, 'Category ID is required'),
        brand: z.string().optional().default('Stereobliss'),
        modelName: z.string().optional(),
        description: z.string().optional(),
        trackingMode: z.enum([TRACKING_MODES.QUANTITY, TRACKING_MODES.SERIALIZED]).optional().default(TRACKING_MODES.QUANTITY),
        unitOfMeasure: z.string().default('pcs'),
        purchaseCost: z.number().min(0, 'Purchase cost must be positive'),
        defaultSellingPrice: z.number().min(0, 'Selling price must be positive'),
        supplier: z.string().optional(),
        minStockThreshold: z.number().min(0).default(5),
        initialStock: z.number().min(0).optional().default(0),
        destinationLocation: z.string().optional(),
        initialSerialNumbers: z.array(z.string()).optional(),
        imageUrl: z.string().optional(),
    }),
});
export const updateProductSchema = z.object({
    body: z.object({
        name: z.string().min(2).optional(),
        color: z.string().optional(),
        hsnCode: z.string().optional(),
        category: z.string().optional(),
        brand: z.string().optional(),
        modelName: z.string().optional(),
        description: z.string().optional(),
        trackingMode: z.enum([TRACKING_MODES.QUANTITY, TRACKING_MODES.SERIALIZED]).optional(),
        unitOfMeasure: z.string().optional(),
        purchaseCost: z.number().min(0).optional(),
        defaultSellingPrice: z.number().min(0).optional(),
        supplier: z.string().optional(),
        minStockThreshold: z.number().min(0).optional(),
        isActive: z.boolean().optional(),
        imageUrl: z.string().optional(),
    }),
});
// Purchases
export const createPurchaseSchema = z.object({
    body: z.object({
        supplier: z.string().min(1, 'Supplier is required'),
        invoiceReference: z.string().optional(),
        orderDate: z.string().optional(),
        destinationLocation: z.string().min(1, 'Location is required'),
        notes: z.string().optional(),
        lineItems: z
            .array(z.object({
            product: z.string().min(1, 'Product is required'),
            quantityOrdered: z.number().int().min(1, 'Quantity must be at least 1'),
            unitCost: z.number().min(0, 'Unit cost must be non-negative'),
        }))
            .min(1, 'At least one line item is required'),
        additionalCosts: z.number().min(0).default(0),
    }),
});
export const receivePurchaseSchema = z.object({
    body: z.object({
        destinationLocation: z.string().min(1, 'Destination location is required'),
        notes: z.string().optional(),
        idempotencyKey: z.string().optional(),
        lineItems: z
            .array(z.object({
            lineId: z.string().nullable().optional(),
            product: z.string().min(1, 'Product ID is required'),
            quantityReceived: z.number().int().min(1, 'Quantity must be at least 1'),
            unitCost: z.number().min(0),
            serializedUnits: z
                .array(z.object({
                assetId: z.string().optional(), // generated if omitted
                manufacturerSerial: z.string().optional(),
                condition: z.enum(Object.values(ITEM_CONDITIONS)).default(ITEM_CONDITIONS.NEW),
                warrantyExpiry: z.string().optional(),
                notes: z.string().optional(),
            }))
                .optional(),
        }))
            .min(1, 'At least one received item is required'),
    }),
});
// Sales
export const createSaleSchema = z.object({
    body: z.object({
        customerName: z.string().min(1, 'Customer name is required'),
        customerEmail: z.string().email().optional().or(z.literal('')),
        customerPhone: z.string().optional(),
        location: z.string().min(1, 'Location is required'),
        paymentMethod: z.enum(Object.values(PAYMENT_METHODS)).default(PAYMENT_METHODS.UPI),
        notes: z.string().optional(),
        remarks: z.string().optional(),
        idempotencyKey: z.string().optional(),
        lineItems: z
            .array(z.object({
            product: z.string().min(1, 'Product ID is required'),
            hsnCode: z.string().optional(),
            quantity: z.number().int().min(1, 'Quantity must be at least 1'),
            unitPrice: z.number().min(0, 'Unit price must be positive'),
            discount: z.number().min(0).default(0),
            serializedItemIds: z.array(z.string()).optional(),
        }))
            .min(1, 'At least one sale item is required'),
    }),
});
// Rentals & Instrument Loans
export const issueInternalUsageSchema = z.object({
    body: z.object({
        purpose: z.enum(Object.values(USAGE_PURPOSES)).default(USAGE_PURPOSES.CLASS),
        customPurposeDetail: z.string().optional(),
        assignedPerson: z.string().min(1, 'Renter / Customer name is required'),
        assignedPersonContact: z.string().optional(),
        customerEmail: z.string().email().optional().or(z.literal('')),
        location: z.string().min(1, 'Location is required'),
        expectedReturnDate: z.string().min(1, 'Expected return date is required'),
        notes: z.string().optional(),
        isRental: z.boolean().optional().default(true),
        lockInPeriodMonths: z.number().int().min(1).max(36).optional().default(3),
        securityDeposit: z.number().min(0).optional().default(0),
        monthlyRent: z.number().min(0).optional().default(0),
        includedAccessories: z.array(z.string()).optional().default([]),
        items: z
            .array(z.object({
            product: z.string().min(1, 'Product ID is required'),
            quantityIssued: z.number().int().min(1, 'Quantity must be at least 1'),
            serializedItemId: z.string().optional(),
            issueCondition: z.enum(Object.values(ITEM_CONDITIONS)).default(ITEM_CONDITIONS.GOOD),
        }))
            .min(1, 'At least one item must be issued'),
    }),
});
export const recordRentalPaymentSchema = z.object({
    body: z.object({
        amount: z.number().min(1, 'Payment amount must be greater than 0'),
        billingMonth: z.string().optional(),
        paymentId: z.string().optional(),
        monthIndex: z.number().optional(),
        paymentMethod: z.enum(Object.values(PAYMENT_METHODS)).default(PAYMENT_METHODS.UPI),
        transactionRef: z.string().optional(),
        notes: z.string().optional(),
        adjustNextMonth: z.boolean().optional(),
    }),
});
export const updateRentalPaymentSchema = z.object({
    body: z.object({
        amountPaid: z.number().min(0, 'Paid amount cannot be negative').optional(),
        amountDue: z.number().min(0, 'Due amount cannot be negative').optional(),
        transactionRef: z.string().optional(),
        paymentMethod: z.enum(Object.values(PAYMENT_METHODS)).optional(),
        notes: z.string().optional(),
        paidAt: z.string().optional(),
        adjustNextMonth: z.boolean().optional(),
    }),
});
export const adjustRentalMonthDueSchema = z.object({
    body: z.object({
        monthIndex: z.number().int().min(1, 'Month index must be at least 1'),
        newAmountDue: z.number().min(0, 'New amount due cannot be negative'),
        reason: z.string().optional(),
    }),
});
export const addRentalMonthSchema = z.object({
    body: z.object({
        amountDue: z.number().min(0).optional(),
        dueDate: z.string().optional(),
    }),
});
export const returnInternalUsageSchema = z.object({
    body: z.object({
        notes: z.string().optional(),
        items: z
            .array(z.object({
            product: z.string().min(1, 'Product ID is required'),
            quantityReturned: z.number().int().min(1, 'Quantity must be at least 1'),
            serializedItemId: z.string().optional(),
            returnCondition: z.enum(Object.values(ITEM_CONDITIONS)),
            inspectionOutcome: z.enum(['OK_TO_STOCK', 'NEEDS_MAINTENANCE', 'QUARANTINE_DAMAGED']),
            inspectionNotes: z.string().optional(),
        }))
            .min(1, 'At least one item must be returned'),
    }),
});
export const extendUsageSchema = z.object({
    body: z.object({
        extendedDate: z.string().min(1, 'New return date is required'),
        reason: z.string().min(3, 'Reason for extension is required'),
    }),
});
// Adjustments
export const requestAdjustmentSchema = z.object({
    body: z.object({
        location: z.string().min(1, 'Location is required'),
        type: z.enum(['WRITE_OFF', 'MANUAL_COUNT', 'DAMAGE_LOSS', 'FOUND_ITEM', 'CORRECTION']),
        reason: z.string().min(5, 'Detailed reason is required'),
        supportingDocumentUrl: z.string().optional(),
        items: z
            .array(z.object({
            product: z.string().min(1, 'Product ID is required'),
            serializedItem: z.string().optional(),
            quantityDelta: z.number().int('Delta must be integer'),
            targetStatus: z.string().optional(),
            reason: z.string().min(3, 'Item reason is required'),
        }))
            .min(1, 'At least one adjustment item is required'),
    }),
});
export const reviewAdjustmentSchema = z.object({
    body: z.object({
        action: z.enum(['APPROVE', 'REJECT']),
        rejectionReason: z.string().optional(),
    }),
});
// Maintenance
export const createMaintenanceSchema = z.object({
    body: z.object({
        product: z.string().min(1, 'Product is required'),
        serializedItem: z.string().optional(),
        location: z.string().min(1, 'Location is required'),
        problemDescription: z.string().min(5, 'Problem description is required'),
        vendor: z.string().optional(),
        cost: z.number().min(0).default(0),
        notes: z.string().optional(),
    }),
});
export const releaseMaintenanceSchema = z.object({
    body: z.object({
        releaseDisposition: z.enum(['AVAILABLE', 'QUARANTINED', 'RETIRED']),
        repairDetails: z.string().min(3, 'Repair details required'),
        cost: z.number().min(0).default(0),
        notes: z.string().optional(),
    }),
});
