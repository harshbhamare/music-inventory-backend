import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';

async function testTx() {
  await connectDB();
  try {
    const { Product } = await import('../models/Product.js');
    const prod = await Product.findOne().session(undefined as any);
    console.log('[SESSION_TEST] Product found:', prod?.name);
    if (prod) {
      await prod.save({ session: undefined as any });
      console.log('[SESSION_TEST] Product saved with session:undefined successfully!');
    }
  } catch (err: any) {
    console.log('[SESSION_TEST] Error:', err.message);
  } finally {
    await disconnectDB();
  }
}

testTx();
