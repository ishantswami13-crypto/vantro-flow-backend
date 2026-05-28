const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORBIDDEN_PATTERNS = [
  /['"](sk_live_[a-zA-Z0-9]+)['"]/g,
  /['"](rzp_live_[a-zA-Z0-9]+)['"]/g,
  /['"](eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)['"]/g, // Generic JWT
];

const EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.json', '.env', '.env.local'];
const IGNORE_DIRS = ['node_modules', '.git', '.github', 'dist', '.next'];

function scanDir(dir) {
  let issues = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.includes(entry.name)) {
        issues = issues.concat(scanDir(fullPath));
      }
    } else {
      const ext = path.extname(entry.name);
      if (EXTENSIONS.includes(ext) && !entry.name.includes('package-lock')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            issues.push(`Possible exposed secret found in ${fullPath}`);
          }
        }
      }
    }
  }
  return issues;
}

console.log('[SECURITY] Starting Secret Scan...');
const issues = scanDir(process.cwd());

if (issues.length > 0) {
  console.error('[SECURITY] FATAL: Exposed secrets detected in codebase!');
  issues.forEach(i => console.error(i));
  process.exit(1);
} else {
  console.log('[SECURITY] Secret Scan Passed: No hardcoded secrets found.');
}
