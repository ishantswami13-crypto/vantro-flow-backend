const fs = require('fs');
const path = require('path');

const serverPath = path.join('C:', 'Users', 'Dell', 'vantro-flow-backend', 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

// Ensure cortex background service is imported
if (!code.includes("const { startCortexBackgroundRefresh } = require('./lib/cortex/backgroundJob');")) {
    const importStr = "const { startCortexBackgroundRefresh } = require('./lib/cortex/backgroundJob');\n";
    code = code.replace("const express = require('express');", "const express = require('express');\n" + importStr);
}

// Add the endpoint
const cortexRoute = `
// ── CORTEX ASYNC BACKGROUND ──────────────────────────────────────────────────
app.post('/api/v1/cortex/refresh', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await startCortexBackgroundRefresh(userId);
    
    // Invalidate caches immediately so the next request pulls fresh or processing state
    CacheService.delByPrefix(\`user:\${userId}:\`);
    
    res.status(202).json({ 
      accepted: true, 
      jobId: result.jobId, 
      status: result.status,
      message: "Cortex refresh started in background" 
    });
  } catch (err) {
    console.error('[CORTEX_REFRESH_ERROR]', err);
    res.status(500).json({ error: 'Failed to start Cortex refresh' });
  }
});

// Error Handling Middleware
`;

if (!code.includes('/api/v1/cortex/refresh')) {
  code = code.replace('// Error Handling Middleware', cortexRoute);
  fs.writeFileSync(serverPath, code);
  console.log('Added cortex async refresh route to server.js');
} else {
  console.log('Cortex refresh route already exists.');
}
