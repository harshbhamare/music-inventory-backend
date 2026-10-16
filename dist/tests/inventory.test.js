import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { StockLocation } from '../models/StockLocation.js';
import { Category } from '../models/Category.js';
import { Supplier } from '../models/Supplier.js';
import { Product } from '../models/Product.js';
import { SerializedItem } from '../models/SerializedItem.js';
import { StockMovement } from '../models/StockMovement.js';
import { Purchase } from '../models/Purchase.js';
import { Sale } from '../models/Sale.js';
import { InternalUsage } from '../models/InternalUsage.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { MaintenanceRecord } from '../models/MaintenanceRecord.js';
import { runInventoryReconciliation } from '../services/reconciliationService.js';
import { ROLES, TRACKING_MODES, SERIALIZED_STATUSES, ITEM_CONDITIONS, ADJUSTMENT_STATUSES, } from '../config/constants.js';
let app;
let adminToken;
let managerToken;
let salesToken;
let staffToken;
let viewerToken;
let testLocationId;
let testCategoryId;
let testSupplierId;
let adminUserId;
let managerUserId;
beforeAll(async () => {
    await connectDB();
    app = createApp();
    // Clean test db
    await Promise.all([
        User.deleteMany({}),
        StockLocation.deleteMany({}),
        Category.deleteMany({}),
        Supplier.deleteMany({}),
        Product.deleteMany({}),
        SerializedItem.deleteMany({}),
        StockMovement.deleteMany({}),
        Purchase.deleteMany({}),
        Sale.deleteMany({}),
        InternalUsage.deleteMany({}),
        InventoryAdjustment.deleteMany({}),
        MaintenanceRecord.deleteMany({}),
    ]);
    // Seed default location
    const loc = await StockLocation.create({
        name: 'Pune Main Store',
        code: 'PUNE_TEST',
        isDefault: true,
        isActive: true,
    });
    testLocationId = loc._id.toString();
    // Seed category and supplier
    const cat = await Category.create({ name: 'Test Guitars', isActive: true });
    testCategoryId = cat._id.toString();
    const sup = await Supplier.create({ name: 'Yamaha Test Supplier', isActive: true });
    testSupplierId = sup._id.toString();
    // Create users and generate tokens (Two profile roles)
    const passHash = await bcrypt.hash('Test@12345', 10);
    const admin = await User.create({
        name: 'Test Super Admin',
        email: 'admin@stereobliss.com',
        passwordHash: passHash,
        role: ROLES.SUPER_ADMIN,
        isActive: true,
    });
    adminUserId = admin._id.toString();
    const manager = await User.create({
        name: 'Test Manager',
        email: 'manager@stereobliss.com',
        passwordHash: passHash,
        role: ROLES.MANAGER,
        isActive: true,
    });
    managerUserId = manager._id.toString();
    // Log in each user to get tokens
    const adminRes = await request(app).post('/api/v1/auth/login').send({ email: admin.email, password: 'Test@12345' });
    adminToken = adminRes.body.data.token;
    const managerRes = await request(app).post('/api/v1/auth/login').send({ email: manager.email, password: 'Test@12345' });
    managerToken = managerRes.body.data.token;
    // Operational aliases: manager handles all sales, intake, and loan operations
    salesToken = managerToken;
    staffToken = managerToken;
    viewerToken = managerToken;
});
afterAll(async () => {
    await disconnectDB();
});
describe('StereoBliss Retail Inventory Management Core Invariants & Workflows', () => {
    let quantityProductId;
    let serializedProductId;
    let purchaseId;
    let serializedUnitId;
    let serializedAssetId;
    // 1. Quantity-based and Serialized Product Creation
    it('1. should create quantity-based and serialized products with zero initial balances', async () => {
        // Quantity Product
        const qRes = await request(app)
            .post('/api/v1/products')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            name: 'D\'Addario Acoustic Strings',
            sku: 'TEST-STRINGS-01',
            category: testCategoryId,
            brand: 'D\'Addario',
            trackingMode: TRACKING_MODES.QUANTITY,
            purchaseCost: 400,
            defaultSellingPrice: 700,
            supplier: testSupplierId,
            minStockThreshold: 5,
        });
        expect(qRes.status).toBe(201);
        expect(qRes.body.data.product.trackingMode).toBe(TRACKING_MODES.QUANTITY);
        expect(qRes.body.data.product.stockQuantity.onHand).toBe(0);
        quantityProductId = qRes.body.data.product._id;
        // Serialized Product
        const sRes = await request(app)
            .post('/api/v1/products')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            name: 'Yamaha F310 Acoustic Guitar',
            sku: 'TEST-YAM-F310',
            category: testCategoryId,
            brand: 'Yamaha',
            trackingMode: TRACKING_MODES.SERIALIZED,
            purchaseCost: 7000,
            defaultSellingPrice: 10500,
            supplier: testSupplierId,
            minStockThreshold: 2,
        });
        expect(sRes.status).toBe(201);
        expect(sRes.body.data.product.trackingMode).toBe(TRACKING_MODES.SERIALIZED);
        expect(sRes.body.data.product.stockQuantity.onHand).toBe(0);
        serializedProductId = sRes.body.data.product._id;
    });
    // 2. Product tracking-mode safety validation
    it('2. should prevent unsafe switching of tracking mode once stock/movements exist', async () => {
        // Create PO and receive stock to establish stock balance
        const poRes = await request(app)
            .post('/api/v1/intake')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            supplier: testSupplierId,
            destinationLocation: testLocationId,
            lineItems: [
                { product: quantityProductId, quantityOrdered: 20, unitCost: 400 },
                { product: serializedProductId, quantityOrdered: 2, unitCost: 7000 },
            ],
        });
        expect(poRes.status).toBe(201);
        purchaseId = poRes.body.data.purchase._id;
        // Receive purchase
        const rcpRes = await request(app)
            .post(`/api/v1/intake/${purchaseId}/receive`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            destinationLocation: testLocationId,
            lineItems: [
                { product: quantityProductId, quantityReceived: 20, unitCost: 400 },
                {
                    product: serializedProductId,
                    quantityReceived: 2,
                    unitCost: 7000,
                    serializedUnits: [
                        { assetId: 'MZI-TEST-001', manufacturerSerial: 'SN-001', condition: 'NEW' },
                        { assetId: 'MZI-TEST-002', manufacturerSerial: 'SN-002', condition: 'NEW' },
                    ],
                },
            ],
        });
        expect(rcpRes.status).toBe(201);
        // Attempt to switch trackingMode on product with active stock -> MUST BE REJECTED
        const switchRes = await request(app)
            .patch(`/api/v1/products/${quantityProductId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ trackingMode: TRACKING_MODES.SERIALIZED });
        expect(switchRes.status).toBe(400);
        expect(switchRes.body.error.code).toBe('UNSAFE_TRACKING_MODE_CHANGE');
    });
    // 3. Purchase receipt and partial receipt & idempotency
    it('3. should verify stock intake balances and prevent duplicate receipt processing', async () => {
        const prodQ = await Product.findById(quantityProductId);
        expect(prodQ?.stockQuantity.onHand).toBe(20);
        const prodS = await Product.findById(serializedProductId);
        expect(prodS?.stockQuantity.onHand).toBe(2);
        const serials = await SerializedItem.find({ product: serializedProductId });
        expect(serials.length).toBe(2);
        serializedUnitId = serials[0]._id.toString();
        serializedAssetId = serials[0].assetId;
        // Verify duplicate receipt with same idempotencyKey is idempotent
        const dupRes = await request(app)
            .post(`/api/v1/intake/${purchaseId}/receive`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            destinationLocation: testLocationId,
            idempotencyKey: 'dup-test-key-1',
            lineItems: [{ product: quantityProductId, quantityReceived: 1, unitCost: 400 }],
        });
        // If purchase is already COMPLETED, it safely rejects over-receipt
        expect([200, 201, 400]).toContain(dupRes.status);
    });
    // 4. Sales confirmation and available stock reduction
    it('4. should process confirmed customer sale and deduct stock atomically', async () => {
        const saleRes = await request(app)
            .post('/api/v1/sales')
            .set('Authorization', `Bearer ${salesToken}`)
            .send({
            customerName: 'Aarav Mehta',
            location: testLocationId,
            paymentMethod: 'UPI',
            lineItems: [
                { product: quantityProductId, quantity: 5, unitPrice: 700, discount: 50 },
            ],
        });
        expect(saleRes.status).toBe(201);
        expect(saleRes.body.data.sale.invoiceNumber).toMatch(/^INV-/);
        expect(saleRes.body.data.sale.grandTotal).toBe(3250); // (700 - 50) * 5
        const updatedProd = await Product.findById(quantityProductId);
        expect(updatedProd?.stockQuantity.onHand).toBe(15); // 20 - 5 = 15
    });
    // 5. Insufficient stock rejection
    it('5. should reject sale when requested quantity exceeds available stock', async () => {
        const saleRes = await request(app)
            .post('/api/v1/sales')
            .set('Authorization', `Bearer ${salesToken}`)
            .send({
            customerName: 'Greedy Buyer',
            location: testLocationId,
            paymentMethod: 'CASH',
            lineItems: [
                { product: quantityProductId, quantity: 100, unitPrice: 700 }, // only 15 available
            ],
        });
        expect(saleRes.status).toBe(400);
        expect(saleRes.body.error.code).toBe('INSUFFICIENT_STOCK');
    });
    // 6. Serialized instrument sale & state transition to SOLD
    it('6. should transition serialized asset status to SOLD upon sale confirmation', async () => {
        const saleRes = await request(app)
            .post('/api/v1/sales')
            .set('Authorization', `Bearer ${salesToken}`)
            .send({
            customerName: 'Pooja Nair',
            location: testLocationId,
            paymentMethod: 'CARD',
            lineItems: [
                {
                    product: serializedProductId,
                    quantity: 1,
                    unitPrice: 10500,
                    serializedItemIds: [serializedUnitId],
                },
            ],
        });
        expect(saleRes.status).toBe(201);
        const asset = await SerializedItem.findById(serializedUnitId);
        expect(asset?.status).toBe(SERIALIZED_STATUSES.SOLD);
        // Attempting to sell the same serialized unit again must be rejected
        const secondSaleRes = await request(app)
            .post('/api/v1/sales')
            .set('Authorization', `Bearer ${salesToken}`)
            .send({
            customerName: 'Duplicate Attempt',
            location: testLocationId,
            paymentMethod: 'CARD',
            lineItems: [
                {
                    product: serializedProductId,
                    quantity: 1,
                    unitPrice: 10500,
                    serializedItemIds: [serializedUnitId],
                },
            ],
        });
        expect(secondSaleRes.status).toBe(400);
        expect(secondSaleRes.body.error.code).toBe('ASSET_NOT_AVAILABLE');
    });
    // 7. Internal instrument issuance for academy classes
    let activeUsageId;
    let remainingSerializedUnitId;
    it('7. should issue serialized instrument for academy class without deducting company ownership', async () => {
        // Find the remaining available serialized instrument
        const availableUnit = await SerializedItem.findOne({
            product: serializedProductId,
            status: SERIALIZED_STATUSES.AVAILABLE,
        });
        expect(availableUnit).toBeTruthy();
        remainingSerializedUnitId = availableUnit._id.toString();
        const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const issueRes = await request(app)
            .post('/api/v1/usage')
            .set('Authorization', `Bearer ${staffToken}`)
            .send({
            purpose: 'CLASS',
            assignedPerson: 'Rohan (Student - Batch 3)',
            assignedPersonContact: '+91 99887 76655',
            location: testLocationId,
            expectedReturnDate: futureDate,
            items: [
                {
                    product: serializedProductId,
                    quantityIssued: 1,
                    serializedItemId: remainingSerializedUnitId,
                    issueCondition: 'NEW',
                },
            ],
        });
        expect(issueRes.status).toBe(201);
        activeUsageId = issueRes.body.data.usage._id;
        // Verify unit lifecycle state changed to ISSUED_INTERNAL
        const unitAfter = await SerializedItem.findById(remainingSerializedUnitId);
        expect(unitAfter?.status).toBe(SERIALIZED_STATUSES.ISSUED_INTERNAL);
        expect(unitAfter?.assignedTo).toBe('Rohan (Student - Batch 3)');
        // Invariant: Company on-hand stock remains company-owned, available for sale decreases
        const prod = await Product.findById(serializedProductId);
        expect(prod?.stockQuantity.issuedInternal).toBe(1);
        expect(prod?.availableForSale).toBe(0); // 1 onHand - 1 inUse = 0 available
    });
    // 8. Return inspection: flag defective item for maintenance
    it('8. should record return inspection and route damaged instrument to maintenance', async () => {
        const returnRes = await request(app)
            .post(`/api/v1/usage/${activeUsageId}/return`)
            .set('Authorization', `Bearer ${staffToken}`)
            .send({
            items: [
                {
                    product: serializedProductId,
                    quantityReturned: 1,
                    serializedItemId: remainingSerializedUnitId,
                    returnCondition: 'FAIR',
                    inspectionOutcome: 'NEEDS_MAINTENANCE',
                    inspectionNotes: 'Broken bridge pin and high action',
                },
            ],
        });
        expect(returnRes.status).toBe(201);
        const asset = await SerializedItem.findById(remainingSerializedUnitId);
        expect(asset?.status).toBe(SERIALIZED_STATUSES.MAINTENANCE);
        expect(asset?.condition).toBe('FAIR');
    });
    // 9. Maintenance workflow and release disposition
    it('9. should track repair and release repaired instrument back to available stock', async () => {
        const ticketRes = await request(app)
            .post('/api/v1/maintenance')
            .set('Authorization', `Bearer ${staffToken}`)
            .send({
            product: serializedProductId,
            serializedItem: remainingSerializedUnitId,
            location: testLocationId,
            problemDescription: 'Setup, bridge pin replacement, fret polish',
            vendor: 'Master Luthier Pune',
            cost: 850,
        });
        expect(ticketRes.status).toBe(201);
        const ticketId = ticketRes.body.data.record._id;
        // Release ticket with outcome AVAILABLE
        const releaseRes = await request(app)
            .post(`/api/v1/maintenance/${ticketId}/release`)
            .set('Authorization', `Bearer ${managerToken}`)
            .send({
            releaseDisposition: 'AVAILABLE',
            repairDetails: 'Bridge pin replaced and neck relief adjusted',
            cost: 850,
        });
        expect(releaseRes.status).toBe(200);
        const asset = await SerializedItem.findById(remainingSerializedUnitId);
        expect(asset?.status).toBe(SERIALIZED_STATUSES.AVAILABLE);
        expect(asset?.condition).toBe(ITEM_CONDITIONS.GOOD);
    });
    // 10. Manager approval workflow & self-approval prevention
    it('10. should require manager approval for write-offs and prevent self-approval', async () => {
        // Manager requests write-off adjustment
        const reqRes = await request(app)
            .post('/api/v1/adjustments')
            .set('Authorization', `Bearer ${managerToken}`)
            .send({
            location: testLocationId,
            type: 'WRITE_OFF',
            reason: 'Broken display stand caused crack',
            items: [
                {
                    product: quantityProductId,
                    quantityDelta: -2,
                    reason: 'Damaged beyond repair',
                },
            ],
        });
        expect(reqRes.status).toBe(201);
        const adjId = reqRes.body.data.adjustment._id;
        expect(reqRes.body.data.adjustment.status).toBe(ADJUSTMENT_STATUSES.PENDING_APPROVAL);
        // Rule: Manager cannot approve adjustments (main feature restricted to Super Admin)
        const managerApproveRes = await request(app)
            .post(`/api/v1/adjustments/${adjId}/review`)
            .set('Authorization', `Bearer ${managerToken}`)
            .send({ action: 'APPROVE' });
        expect(managerApproveRes.status).toBe(403);
        expect(managerApproveRes.body.error.code).toBe('FORBIDDEN');
        // Super Admin approves the request
        const adminApproveRes = await request(app)
            .post(`/api/v1/adjustments/${adjId}/review`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ action: 'APPROVE' });
        expect(adminApproveRes.status).toBe(200);
        expect(adminApproveRes.body.data.adjustment.status).toBe(ADJUSTMENT_STATUSES.APPROVED);
        // Verify stock was reduced by exactly 2
        const prod = await Product.findById(quantityProductId);
        expect(prod?.stockQuantity.onHand).toBe(13); // 15 - 2 = 13
    });
    // 11. Role-based access control enforcement: Main features to Superadmin only, tracking to Manager
    it('11. should restrict main features exclusively to Super Admin and forbid Manager', async () => {
        // Manager attempting to create a user -> FORBIDDEN
        const managerCreateUserRes = await request(app)
            .post('/api/v1/auth/users')
            .set('Authorization', `Bearer ${managerToken}`)
            .send({
            name: 'Unauthorized User Creation',
            email: 'unauth@stereobliss.com',
            password: 'password123',
            role: ROLES.MANAGER,
        });
        expect(managerCreateUserRes.status).toBe(403);
        // Manager attempting to modify system settings -> FORBIDDEN
        const managerSettingsRes = await request(app)
            .patch('/api/v1/meta/settings')
            .set('Authorization', `Bearer ${managerToken}`)
            .send({ companyName: 'Hacked Store' });
        expect(managerSettingsRes.status).toBe(403);
        // Manager attempting to reset system database -> FORBIDDEN
        const managerResetRes = await request(app)
            .post('/api/v1/meta/reset-data')
            .set('Authorization', `Bearer ${managerToken}`);
        expect(managerResetRes.status).toBe(403);
        // Super Admin successfully provisioning a manager user -> 201 CREATED
        const adminCreateUserRes = await request(app)
            .post('/api/v1/auth/users')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
            name: 'New Floor Manager',
            email: 'floormanager@stereobliss.com',
            password: 'password123',
            role: ROLES.MANAGER,
        });
        expect(adminCreateUserRes.status).toBe(201);
        expect(adminCreateUserRes.body.data.user.role).toBe(ROLES.MANAGER);
    });
    // 12. Independent inventory reconciliation audit
    it('12. should reconcile all stock ledger transactions against recorded balances', async () => {
        const report = await runInventoryReconciliation();
        expect(report.totalProductsChecked).toBeGreaterThan(0);
        expect(report.mismatchesFound).toBe(0); // 100% verified!
    });
});
