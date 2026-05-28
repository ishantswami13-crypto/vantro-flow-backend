const { execSync } = require('child_process');

const BLOCKED_PACKAGES = {
  'axios': ['1.14.1', '0.30.4'],
  'plain-crypto-js': ['*'],
};

console.log('[SECURITY] Running Supply Chain Checks...');

try {
  // 1. Run NPM Audit
  console.log('[SECURITY] Running npm audit...');
  execSync('npm audit --audit-level=high', { stdio: 'inherit' });
  console.log('[SECURITY] npm audit passed.');

  // 2. Check for blocked packages
  console.log('[SECURITY] Checking for blocked/malicious packages...');
  const lsOutput = execSync('npm ls --json', { encoding: 'utf8' });
  const tree = JSON.parse(lsOutput);
  
  let foundBlocked = false;
  
  if (tree.dependencies) {
    for (const [pkg, details] of Object.entries(tree.dependencies)) {
      if (BLOCKED_PACKAGES[pkg]) {
        const blockedVersions = BLOCKED_PACKAGES[pkg];
        if (blockedVersions.includes('*') || blockedVersions.includes(details.version)) {
          console.error(`[FATAL] Blocked package found: ${pkg}@${details.version}`);
          foundBlocked = true;
        }
      }
    }
  }
  
  if (foundBlocked) {
    process.exit(1);
  }
  
  console.log('[SECURITY] Supply Chain Check Passed.');

} catch (err) {
  console.error('[SECURITY] Supply Chain Check Failed.');
  process.exit(1);
}
