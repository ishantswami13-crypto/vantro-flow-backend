const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

// The anchor that actually exists at the bottom of server.js
const anchor = 'app.use(async (err, req, res, next) => {';

if (code.includes(anchor)) {
    let newRoutes = '';
    
    // Grab bootstrap routes
    const bootstrapSrc = fs.readFileSync(path.join(__dirname, 'patch_bootstrap.js'), 'utf8');
    const bStart = bootstrapSrc.indexOf('// ── PERFORMANCE BOOTSTRAP ROUTES ─────────────────────────────────────────────');
    const bEnd = bootstrapSrc.indexOf('// Error Handling Middleware');
    if (bStart !== -1 && bEnd !== -1) {
        newRoutes += bootstrapSrc.substring(bStart, bEnd) + '\n';
    }

    // Grab cortex route
    const cortexSrc = fs.readFileSync(path.join(__dirname, 'patch_cortex.js'), 'utf8');
    const cStart = cortexSrc.indexOf('// ── CORTEX ASYNC REFRESH ──────────────────────────────────────────────────');
    const cEnd = cortexSrc.indexOf('// Error Handling Middleware');
    if (cStart !== -1 && cEnd !== -1) {
        newRoutes += cortexSrc.substring(cStart, cEnd) + '\n';
    }
    
    if (newRoutes) {
        code = code.replace(anchor, newRoutes + anchor);
        fs.writeFileSync(serverPath, code);
        console.log('Successfully injected proper routes before error handler!');
    } else {
        console.log('Could not extract routes from patch scripts');
    }
} else {
    console.log('Anchor not found!');
}
