import mongoose from 'mongoose';
import { ENV } from './env.js';
let mongodReplSet = null;
export async function connectDB() {
    if (mongoose.connection.readyState >= 1) {
        return mongoose;
    }
    const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
    let uri = isTest ? (process.env.TEST_MONGODB_URI || '') : ENV.MONGODB_URI;
    if (!uri) {
        console.log('[DB] No MONGODB_URI provided (or test environment). Starting in-memory MongoDB Replica Set...');
        try {
            const { MongoMemoryReplSet } = await import('mongodb-memory-server');
            mongodReplSet = await MongoMemoryReplSet.create({
                replSet: { count: 1, storageEngine: 'wiredTiger' },
            });
            uri = mongodReplSet.getUri();
            console.log(`[DB] In-memory MongoDB Replica Set active at ${uri}`);
        }
        catch (err) {
            console.error('[DB] Failed to initialize MongoMemoryReplSet:', err);
            throw err;
        }
    }
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, {
        autoIndex: true,
    });
    console.log('[DB] MongoDB Connected successfully.');
    try {
        const admin = mongoose.connection.db?.admin();
        const hello = await admin?.command({ hello: 1 });
        isReplicaSet = Boolean(hello?.setName);
        console.log(`[DB] Deployment topology: ${isReplicaSet ? 'Replica Set (ACID transactions enabled)' : 'Standalone (single-server mode)'}`);
    }
    catch {
        isReplicaSet = false;
    }
    return mongoose;
}
let isReplicaSet = false;
export function areTransactionsSupported() {
    return isReplicaSet;
}
export async function withTransaction(work) {
    if (!isReplicaSet) {
        return await work(null);
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const result = await work(session);
        await session.commitTransaction();
        return result;
    }
    catch (err) {
        await session.abortTransaction();
        throw err;
    }
    finally {
        session.endSession();
    }
}
export async function disconnectDB() {
    await mongoose.disconnect();
    if (mongodReplSet) {
        await mongodReplSet.stop();
        mongodReplSet = null;
    }
}
