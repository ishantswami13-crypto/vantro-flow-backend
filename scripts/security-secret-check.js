const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DANGEROUS_PATTERNS = [
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /JWT_SECRET/i,
  /DATABASE_URL/i,
  /RAILWAY_TOKEN/i,
  /VERCEL_TOKEN/i,
  /RAZORPAY_SECRET/i,
  /STRIPE_SECRET/i,
  /OPENAI_API_KEY/i,
  /ANTHROPIC_API_KEY/i,
  /GOOGLE_API_KEY/i,
  /TWILIO_AUTH_TOKEN/i,
  /WHATSAPP_TOKEN/i,
  /BEGIN PRIVATE KEY/i,
  /Bearer ey/
];

const FORBIDDEN_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.secret'];
const IGNORED_DIRS = ['.git', 'node_modules', '.next', 'out', 'build', '.vercel', '.railway'];

let hasError = false;

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.includes(file)) {
        scanDir(fullPath);
      }
    } else {
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  // Check forbidden files
  if (
    FORBIDDEN_EXTENSIONS.includes(ext) ||
    basename === '.env' ||
    basename === '.env.local' ||
    basename === '.env.production' ||
    basename.startsWith('service-account')
  ) {
    console.error(`[DANGER] Forbidden file found: ${filePath}`);
    hasError = true;
    return;
  }

  // Skip binaries or large minified files loosely
  if (['.json', '.md', '.png', '.jpg', '.svg', '.woff', '.woff2'].includes(ext)) return;
  if (basename === 'package-lock.json' || basename === 'yarn.lock') return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(content) && basename !== 'security-secret-check.js' && basename !== '.env.example' && basename !== 'frontend-env-guard.js' && basename !== 'server.js' && basename !== 'supabase-schema.sql' && basename !== 'supabaseClient.js') {
      console.error(`[WARNING] Potential secret leak in ${filePath}: matched pattern ${pattern}`);
      hasError = true;
    }
  }
}

console.log('Running secret leak prevention checks...');
scanDir(path.resolve(__dirname, '..'));

if (hasError) {
  console.error('\nSecret check failed! Fix the issues before committing.');
  process.exit(1);
} else {
  console.log('Secret check passed successfully.');
}
