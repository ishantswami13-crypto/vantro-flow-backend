const REQUIRED_SECRETS = [
  'JWT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'RAZORPAY_WEBHOOK_SECRET',
  'VOICE_WEBHOOK_SECRET'
];

console.log('[SECURITY] Running Secret Rotation Checklist...');

let missing = false;
REQUIRED_SECRETS.forEach(secret => {
  if (!process.env[secret]) {
    console.warn(`[WARN] Secret ${secret} is NOT configured.`);
    missing = true;
  } else {
    // Only check length/format, NEVER print value
    console.log(`[OK] Secret ${secret} is present (Length: ${process.env[secret].length}).`);
  }
});

if (missing) {
  console.log('[INFO] Please ensure all secrets are rotated and provided in the environment variables.');
} else {
  console.log('[SUCCESS] All required secrets are configured.');
}
