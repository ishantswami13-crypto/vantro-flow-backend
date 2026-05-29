const fs = require('fs');
const path = require('path');

const serverPath = path.join('C:', 'Users', 'Dell', 'vantro-flow-backend', 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

// Ensure cache service is imported
if (!code.includes("const CacheService = require('./lib/cache/cache.service');")) {
    const importStr = "const CacheService = require('./lib/cache/cache.service');\n";
    // Find the const express line
    code = code.replace("const express = require('express');", "const express = require('express');\n" + importStr);
}

// Ensure the new routes are added before Error Handling
const bootstrapRoutes = `
// ── PERFORMANCE BOOTSTRAP ROUTES ─────────────────────────────────────────────
app.get('/api/v1/dashboard/bootstrap', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = \`user:\${userId}:dashboard_bootstrap\`;
    
    // Return cached summary if available (30s TTL)
    const cached = CacheService.get(cacheKey);
    if (cached) return res.json(cached);

    // Parallel minimal DB queries for critical summary
    const [
      { count: salesCount, data: salesTotal },
      { count: purchasesCount },
      { count: overdueCount },
      { count: lowStockCount },
      { data: topActions }
    ] = await Promise.all([
      supabase.from('invoices').select('total_amount', { count: 'exact' }).eq('user_id', userId).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
      supabase.from('purchases').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
      supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('payment_status', 'Overdue'),
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('user_id', userId).lt('current_stock', 5), // Simplified low stock query
      supabase.from('ai_actions').select('id, title, priority').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(3)
    ]);

    const payload = {
      kpis: {
        todaySales: salesTotal?.reduce((sum, s) => sum + (s.total_amount || 0), 0) || 0,
        todayPurchasesCount: purchasesCount || 0,
        overdueInvoicesCount: overdueCount || 0,
        lowStockCount: lowStockCount || 0
      },
      topActions: topActions || [],
      lastUpdated: new Date().toISOString()
    };

    CacheService.set(cacheKey, payload, 30); // 30 second cache
    res.json(payload);
  } catch (err) {
    console.error('[BOOTSTRAP_ERROR]', err);
    res.status(500).json({ error: 'Failed to bootstrap dashboard' });
  }
});

app.get('/api/v1/collections/bootstrap', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = \`user:\${userId}:collections_bootstrap\`;
    const cached = CacheService.get(cacheKey);
    if (cached) return res.json(cached);

    const [
      { data: invoices },
      { data: promises }
    ] = await Promise.all([
      supabase.from('invoices').select('total_amount, amount_paid, payment_status, due_date').eq('user_id', userId).not('payment_status', 'eq', 'Paid'),
      supabase.from('promises').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'broken')
    ]);

    let totalReceivables = 0;
    let overdueAmount = 0;
    let dueToday = 0;
    
    const today = new Date().toISOString().split('T')[0];

    (invoices || []).forEach(inv => {
      const remaining = (inv.total_amount || 0) - (inv.amount_paid || 0);
      totalReceivables += remaining;
      if (inv.payment_status === 'Overdue') overdueAmount += remaining;
      if (inv.due_date && inv.due_date.startsWith(today)) dueToday += remaining;
    });

    const payload = {
      summary: {
        totalReceivables,
        overdueAmount,
        dueToday,
        brokenPromisesCount: promises?.length || 0
      },
      lastUpdated: new Date().toISOString()
    };

    CacheService.set(cacheKey, payload, 45); // 45 second cache
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Failed to bootstrap collections' });
  }
});

// Error Handling Middleware
`;

if (!code.includes('/api/v1/dashboard/bootstrap')) {
  code = code.replace('// Error Handling Middleware', bootstrapRoutes);
  fs.writeFileSync(serverPath, code);
  console.log('Added bootstrap routes to server.js');
} else {
  console.log('Bootstrap routes already exist.');
}
