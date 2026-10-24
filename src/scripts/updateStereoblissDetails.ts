import { connectDB, disconnectDB } from '../config/db.js';
import { AppSetting } from '../models/AppSetting.js';

async function updateDetails() {
  await connectDB();

  let setting = await AppSetting.findOne();
  if (!setting) {
    setting = new AppSetting();
  }

  setting.companyName = 'STEREOBLISS';
  setting.storeName = 'Stereobliss Wakad Store';
  setting.address = '2nd Floor, Radhika Avenue, Wakad- Nasik Road, Next to Copa Vila';
  setting.contactPhone = '9960540161';
  setting.contactEmail = 'harsh.bagle@muziclub.com';
  setting.gstin = '27ADDFS8850Q1Z6';
  setting.stateName = 'Maharashtra';
  setting.stateCode = '27';

  await setting.save();
  console.log('[SUCCESS] Successfully updated AppSetting with official Stereobliss credentials matching reference_invoice.jpg:');
  console.log(JSON.stringify(setting.toObject(), null, 2));

  await disconnectDB();
  process.exit(0);
}

updateDetails().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
