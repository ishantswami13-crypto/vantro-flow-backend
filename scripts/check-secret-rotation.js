const fs = require('fs');
const path = require('path');
require('dotenv').config();

const POLICY_FILE = path.join(__dirname, '../secret-rotation-policy.json');

function checkRotation() {
  if (!fs.existsSync(POLICY_FILE)) {
    console.error('❌ Missing secret-rotation-policy.json');
    process.exit(1);
  }

  const policy = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  let errors = 0;
  let warnings = 0;

  console.log('🔒 Vantro Secret Rotation Check');
  console.log('===============================\n');

  for (const [secretName, config] of Object.entries(policy)) {
    const isPresent = !!process.env[secretName];
    const isCurrentPresent = !!process.env[`${secretName}_CURRENT`];
    const isPreviousPresent = !!process.env[`${secretName}_PREVIOUS`];

    if (!isPresent && !isCurrentPresent && config.risk === 'critical') {
      console.error(`❌ CRITICAL SECRET MISSING: ${secretName} (or ${secretName}_CURRENT)`);
      errors++;
      continue;
    }

    if (config.supportsPrevious) {
      if (!isCurrentPresent && isPresent) {
        console.warn(`⚠️  WARNING: ${secretName} is present, but missing _CURRENT/_PREVIOUS pattern. Consider migrating to ${secretName}_CURRENT for zero-downtime rotation.`);
        warnings++;
      } else if (isCurrentPresent && !isPreviousPresent) {
        console.log(`✅ ${secretName} is using _CURRENT (no _PREVIOUS active)`);
      } else if (isCurrentPresent && isPreviousPresent) {
        console.log(`✅ ${secretName} is mid-rotation (both _CURRENT and _PREVIOUS active)`);
      }
    } else {
      if (isPresent) {
        console.log(`✅ ${secretName} is present.`);
      }
    }
  }

  console.log('\n===============================');
  if (errors > 0) {
    console.error(`🚨 Check failed with ${errors} critical errors.`);
    process.exit(1);
  }

  if (warnings > 0) {
    console.log(`⚠️  Check passed with ${warnings} warnings.`);
  } else {
    console.log(`🎉 All required secrets configured properly.`);
  }
}

checkRotation();
