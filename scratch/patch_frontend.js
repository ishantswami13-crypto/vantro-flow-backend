const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, '..', '..', 'vantro-flow-frontend', 'app', 'dashboard', 'page.tsx');
const collPath = path.join(__dirname, '..', '..', 'vantro-flow-frontend', 'app', 'collections', 'page.tsx');

// --- Patch Dashboard ---
let dashCode = fs.readFileSync(dashPath, 'utf8');

if (!dashCode.includes('import { useQuery }')) {
  dashCode = dashCode.replace('import { useState, useEffect } from "react";', 'import { useState, useEffect } from "react";\nimport { useQuery } from "@tanstack/react-query";');
}

const dashAnchor = 'const [metrics, setMetrics]   = useState<Metrics | null>(null);';
if (dashCode.includes(dashAnchor) && !dashCode.includes('dashboard_bootstrap')) {
  const dashPatch = \`
  const [metrics, setMetrics]   = useState<Metrics | null>(null);

  const { data: bootstrapResponse } = useQuery({
    queryKey: ['dashboard_bootstrap'],
    queryFn: () => api.bootstrap.dashboard(),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (bootstrapResponse?.success) {
      const b = bootstrapResponse;
      setMetrics({
        total_outstanding: b.kpis?.totalReceivables || 0,
        total_payable: 0,
        total_paid: b.kpis?.todaySales || 0,
        pending_invoices: b.kpis?.overdueAmount ? 1 : 0,
        total_customers: b.kpis?.totalReceivables > 0 ? 1 : 0,
        total_suppliers: 0,
        calls_made: 0,
        avg_recovery_rate: 0
      });
      
      const token = localStorage.getItem("vantro_token");
      fetch("\${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/cortex/refresh", {
        method: "POST",
        headers: { Authorization: \`Bearer \${token}\` }
      }).catch(() => {});
    }
  }, [bootstrapResponse]);
\`;
  dashCode = dashCode.replace(dashAnchor, dashPatch);
  dashCode = dashCode.replace('api.metrics(user.id).then(d => setMetrics(d.metrics)).catch(() => {});', '// api.metrics(user.id).then(d => setMetrics(d.metrics)).catch(() => {});');
  fs.writeFileSync(dashPath, dashCode);
  console.log('Patched dashboard');
} else {
  console.log('Dashboard already patched');
}

// --- Patch Collections ---
let collCode = fs.readFileSync(collPath, 'utf8');

if (!collCode.includes('import { useQuery }')) {
  collCode = collCode.replace('import { useState, useMemo, useEffect, useRef, useCallback } from "react";', 'import { useState, useMemo, useEffect, useRef, useCallback } from "react";\nimport { useQuery } from "@tanstack/react-query";');
}

const collAnchor = 'const [summary, setSummary]         = useState<any>(null);';
if (collCode.includes(collAnchor) && !collCode.includes('collections_bootstrap')) {
  const collPatch = \`
  const [summary, setSummary]         = useState<any>(null);

  const { data: bootstrapResponse } = useQuery({
    queryKey: ['collections_bootstrap'],
    queryFn: () => api.bootstrap.collections(),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (bootstrapResponse?.success) {
      setSummary({
        total_outstanding: bootstrapResponse.summary?.totalReceivables || 0,
        total_customers: bootstrapResponse.summary?.highRiskCustomersCount || 0,
        most_overdue_days: 0
      });
    }
  }, [bootstrapResponse]);
\`;
  collCode = collCode.replace(collAnchor, collPatch);
  // Comment out api.collections.summary
  collCode = collCode.replace(/api\.collections\.summary\(user\.id\)/g, '// api.collections.summary(user.id)');
  fs.writeFileSync(collPath, collCode);
  console.log('Patched collections');
} else {
  console.log('Collections already patched (or anchor missing)');
}
