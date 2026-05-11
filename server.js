// FILE: server.js
// VANTRO FLOW BACKEND - Complete Node.js + Express API
// Deploy to: Railway.app

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
const allowedOrigins = [
  'http://localhost:3000',
  'https://vantro-flow.vercel.app',
  'https://vantro-flow-frontend.vercel.app'
];
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
    const trimmed = o.trim();
    if (trimmed && !allowedOrigins.includes(trimmed)) allowedOrigins.push(trimmed);
  });
}
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, phone, business_name } = req.body;

    if (!email || !phone || !business_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabase
      .from('users')
      .insert([{ email, phone, business_name, created_at: new Date() }])
      .select();

    if (error) throw error;

    res.json({ success: true, user: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, user: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CSV UPLOAD & INVOICE PROCESSING
// ============================================

/**
 * Parse a single CSV row, handling quoted fields with commas inside them.
 * e.g.: "Sharma, Traders",50000,2024-01-01,Pending
 */
function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      // Handle escaped quotes ("")
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  try {
    const userId = req.body.user_id;

    if (!userId || !req.file) {
      return res.status(400).json({ error: 'Missing user_id or file' });
    }

    const invoices = [];
    const csvContent = req.file.buffer.toString('utf-8');
    const rows = csvContent.split('\n').slice(1); // Skip header

    for (const row of rows) {
      if (!row.trim()) continue;

      const fields = parseCSVRow(row);
      const [customer_name, invoice_amount, invoice_date, payment_status] = fields;

      if (!customer_name || !invoice_amount || !invoice_date) continue;

      const parsedAmount = parseFloat(invoice_amount);
      const parsedDate = new Date(invoice_date);

      if (isNaN(parsedAmount) || isNaN(parsedDate.getTime())) continue;

      const daysOverdue = Math.floor(
        (Date.now() - parsedDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      invoices.push({
        user_id: userId,
        customer_name,
        invoice_amount: parsedAmount,
        invoice_date,
        payment_status: payment_status || 'Pending',
        days_overdue: daysOverdue,
        created_at: new Date()
      });
    }

    if (invoices.length === 0) {
      return res.status(400).json({ error: 'No valid invoices in CSV' });
    }

    const { data, error } = await supabase
      .from('invoices')
      .insert(invoices)
      .select();

    if (error) throw error;

    res.json({ success: true, count: invoices.length, invoices: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DASHBOARD - GET ALL INVOICES
// ============================================

app.get('/api/invoices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('user_id', userId)
      .order('days_overdue', { ascending: false });

    if (error) throw error;

    const totalOutstanding = data.reduce((sum, inv) => sum + inv.invoice_amount, 0);

    res.json({
      success: true,
      invoices: data,
      summary: {
        total_outstanding: totalOutstanding,
        total_customers: new Set(data.map(inv => inv.customer_name)).size,
        most_overdue_days: data.length > 0 ? data[0].days_overdue : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PRIORITY RANKING - CALCULATE PRIORITY SCORES
// ============================================

function calculatePriorityScore(invoice, paymentHistory = 0) {
  return (invoice.invoice_amount * invoice.days_overdue) / (1 + paymentHistory);
}

function getUrgencyLabel(score) {
  if (score > 3000000) return 'CRITICAL';
  if (score > 1000000) return 'URGENT';
  if (score > 100000) return 'OVERDUE';
  return 'OKAY';
}

app.post('/api/calculate-priority/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending');

    if (error) throw error;

    const priorityList = invoices
      .map(inv => {
        const priority_score = calculatePriorityScore(inv, 0);
        return {
          ...inv,
          priority_score,
          urgency: getUrgencyLabel(priority_score)
        };
      })
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, 10);

    res.json({ success: true, priority_list: priorityList });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MESSAGE GENERATION - CLAUDE API INTEGRATION
// ============================================

const MESSAGE_SYSTEM_PROMPT = `You are a collection message generator for small Indian business owners.

Generate a WhatsApp message in Hinglish (Hindi + English mix) to collect payment.

Rules:
1. Keep it short (3-4 lines max)
2. Be friendly but firm
3. Include specific amount and timeline
4. Ask for WhatsApp confirmation (✓✓)
5. Sound like a real business owner, not corporate
6. Use Hinglish (mix of Hindi and English)

Examples of good messages:
"Hi Kumar, ₹50,000 ka payment abhi tak nahi aaya. 40 din ho gaye. Kya aap kal tak pay kar sakte ho? Whatsapp par confirm kar dijiye thanks!"

"Sharma bhai, invoice ₹75,000 ka overdue ho gaya. 60 din ho gaye. Paisa bhej dijiye na. Confirm kar dijiye."

Generate the exact message (just the message, no intro/outro):`;

app.post('/api/generate-message', async (req, res) => {
  try {
    const { customer_name, amount, days_overdue } = req.body;

    if (!customer_name || !amount || days_overdue === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        messages: [
          { role: 'system', content: MESSAGE_SYSTEM_PROMPT },
          { role: 'user', content: `Customer name: ${customer_name}\nAmount owed: ₹${amount}\nDays overdue: ${days_overdue} days` }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Groq API error');
    }

    const generatedText = data.choices[0]?.message?.content || '';

    res.json({
      success: true,
      message: generatedText.trim()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PAYMENT TRACKING
// ============================================

app.post('/api/mark-paid', async (req, res) => {
  try {
    const { invoice_id, payment_date, payment_amount, payment_method, payment_notes } = req.body;

    const { data, error } = await supabase
      .from('invoices')
      .update({
        payment_status: 'Paid',
        updated_at: new Date(),
        payment_date: payment_date || new Date().toISOString().split('T')[0],
        payment_amount: payment_amount || null,
        payment_method: payment_method || null,
        payment_notes: payment_notes || null
      })
      .eq('id', invoice_id)
      .select();

    if (error) throw error;

    res.json({ success: true, invoice: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CALL TRACKING
// ============================================

app.post('/api/log-call', async (req, res) => {
  try {
    const {
      user_id, customer_name, amount, notes,
      invoice_id, customer_phone, call_duration_minutes,
      did_pick_up, promised_payment_date, promised_amount
    } = req.body;

    const { data, error } = await supabase
      .from('call_logs')
      .insert([{
        user_id,
        customer_name,
        amount,
        notes,
        invoice_id: invoice_id || null,
        customer_phone: customer_phone || null,
        call_duration_minutes: call_duration_minutes || null,
        did_pick_up: did_pick_up !== undefined ? did_pick_up : null,
        promised_payment_date: promised_payment_date || null,
        promised_amount: promised_amount || null,
        called_at: new Date()
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, log: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('user_id', userId)
      .order('called_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, calls: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/call/:callId/update', async (req, res) => {
  try {
    const { callId } = req.params;
    const { notes, did_pick_up, promised_payment_date, promised_amount, call_duration_minutes } = req.body;

    const { data, error } = await supabase
      .from('call_logs')
      .update({ notes, did_pick_up, promised_payment_date, promised_amount, call_duration_minutes })
      .eq('id', callId)
      .select();

    if (error) throw error;

    res.json({ success: true, log: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// METRICS & DASHBOARD
// ============================================

app.get('/api/metrics/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ data: invoices }, { data: callLogs }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId)
    ]);

    const safeInvoices = invoices || [];
    const safeCallLogs = callLogs || [];

    const metrics = {
      total_outstanding: safeInvoices.reduce(
        (sum, inv) => sum + (inv.payment_status === 'Pending' ? inv.invoice_amount : 0),
        0
      ),
      total_paid: safeInvoices.reduce(
        (sum, inv) => sum + (inv.payment_status === 'Paid' ? inv.invoice_amount : 0),
        0
      ),
      pending_invoices: safeInvoices.filter(inv => inv.payment_status === 'Pending').length,
      total_customers: new Set(safeInvoices.map(inv => inv.customer_name)).size,
      calls_made: safeCallLogs.length,
      avg_recovery_rate:
        safeInvoices.length > 0
          ? (
              (safeInvoices.filter(inv => inv.payment_status === 'Paid').length /
                safeInvoices.length) *
              100
            ).toFixed(1)
          : 0
    };

    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ANALYTICS
// ============================================

app.get('/api/analytics/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ data: invoices }, { data: callLogs }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId)
    ]);

    const safeInvoices = invoices || [];
    const safeCallLogs = callLogs || [];

    const paidInvoices = safeInvoices.filter(inv => inv.payment_status === 'Paid');
    const pendingInvoices = safeInvoices.filter(inv => inv.payment_status === 'Pending');

    // Monthly recovery for last 6 months
    const monthly = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthly[key] = { month: key, recovered: 0, invoices_paid: 0 };
    }
    paidInvoices.forEach(inv => {
      const date = inv.payment_date || inv.updated_at;
      if (!date) return;
      const key = date.substring(0, 7);
      if (monthly[key]) {
        monthly[key].recovered += Number(inv.payment_amount || inv.invoice_amount);
        monthly[key].invoices_paid += 1;
      }
    });

    // Top customers by outstanding amount
    const customerMap = {};
    pendingInvoices.forEach(inv => {
      if (!customerMap[inv.customer_name]) customerMap[inv.customer_name] = 0;
      customerMap[inv.customer_name] += Number(inv.invoice_amount);
    });
    const topCustomers = Object.entries(customerMap)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    const totalOutstanding = pendingInvoices.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const totalRecovered = paidInvoices.reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount), 0);
    const recoveryRate = safeInvoices.length > 0
      ? ((paidInvoices.length / safeInvoices.length) * 100).toFixed(1)
      : 0;

    res.json({
      success: true,
      analytics: {
        total_outstanding: totalOutstanding,
        total_recovered: totalRecovered,
        recovery_rate: recoveryRate,
        total_invoices: safeInvoices.length,
        paid_invoices: paidInvoices.length,
        pending_invoices: pendingInvoices.length,
        calls_made: safeCallLogs.length,
        monthly_trend: Object.values(monthly),
        top_customers: topCustomers
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INVENTORY MANAGEMENT
// ============================================

// --- Products ---

app.get('/api/inventory/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const [{ data: products }, { data: movements }] = await Promise.all([
      supabase.from('products').select('*').eq('user_id', userId).order('name'),
      supabase.from('stock_movements').select('*').eq('user_id', userId).order('moved_at', { ascending: false }).limit(50)
    ]);

    const safeProducts = products || [];
    const totalValue = safeProducts.reduce((s, p) => s + Number(p.current_stock) * Number(p.unit_price), 0);
    const lowStock = safeProducts.filter(p => p.current_stock > 0 && p.current_stock <= p.low_stock_alert);
    const outOfStock = safeProducts.filter(p => p.current_stock === 0);

    res.json({
      success: true,
      products: safeProducts,
      movements: movements || [],
      summary: {
        total_products: safeProducts.length,
        total_value: totalValue,
        low_stock_count: lowStock.length,
        out_of_stock_count: outOfStock.length,
        low_stock_items: lowStock,
        out_of_stock_items: outOfStock
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { user_id, name, sku, description, unit_price, unit, current_stock, low_stock_alert, category } = req.body;
    if (!user_id || !name) return res.status(400).json({ error: 'user_id and name required' });

    const { data, error } = await supabase
      .from('products')
      .insert([{ user_id, name, sku: sku || null, description: description || null, unit_price: unit_price || 0, unit: unit || 'unit', current_stock: current_stock || 0, low_stock_alert: low_stock_alert || 10, category: category || null }])
      .select();

    if (error) throw error;
    res.json({ success: true, product: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { name, sku, description, unit_price, unit, low_stock_alert, category } = req.body;

    const { data, error } = await supabase
      .from('products')
      .update({ name, sku, description, unit_price, unit, low_stock_alert, category, updated_at: new Date() })
      .eq('id', productId)
      .select();

    if (error) throw error;
    res.json({ success: true, product: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products/:productId/delete', async (req, res) => {
  try {
    const { productId } = req.params;
    const { error } = await supabase.from('products').delete().eq('id', productId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Stock Movements ---

app.post('/api/stock/move', async (req, res) => {
  try {
    const { user_id, product_id, movement_type, quantity, unit_cost, reference, notes } = req.body;
    if (!user_id || !product_id || !movement_type || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const qty = parseInt(quantity);
    const delta = movement_type === 'in' ? qty : -qty;

    const { data: product, error: fetchErr } = await supabase
      .from('products').select('current_stock').eq('id', product_id).single();
    if (fetchErr) throw fetchErr;

    const newStock = Math.max(0, (product.current_stock || 0) + delta);

    const [{ data: movement, error: movErr }, { error: updateErr }] = await Promise.all([
      supabase.from('stock_movements').insert([{
        user_id, product_id, movement_type, quantity: qty,
        unit_cost: unit_cost || null, reference: reference || null, notes: notes || null
      }]).select(),
      supabase.from('products').update({ current_stock: newStock, updated_at: new Date() }).eq('id', product_id)
    ]);

    if (movErr) throw movErr;
    if (updateErr) throw updateErr;

    res.json({ success: true, movement: movement[0], new_stock: newStock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stock/movements/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('stock_movements')
      .select('*, products(name, unit)')
      .eq('user_id', userId)
      .order('moved_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, movements: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Suppliers ---

app.get('/api/suppliers/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('suppliers').select('*').eq('user_id', userId).order('name');
    if (error) throw error;
    res.json({ success: true, suppliers: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/suppliers', async (req, res) => {
  try {
    const { user_id, name, phone, email, address, payment_terms } = req.body;
    if (!user_id || !name) return res.status(400).json({ error: 'user_id and name required' });

    const { data, error } = await supabase
      .from('suppliers')
      .insert([{ user_id, name, phone: phone || null, email: email || null, address: address || null, payment_terms: payment_terms || 30 }])
      .select();

    if (error) throw error;
    res.json({ success: true, supplier: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/suppliers/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { name, phone, email, address, payment_terms } = req.body;

    const { data, error } = await supabase
      .from('suppliers').update({ name, phone, email, address, payment_terms }).eq('id', supplierId).select();
    if (error) throw error;
    res.json({ success: true, supplier: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/suppliers/:supplierId/delete', async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { error } = await supabase.from('suppliers').delete().eq('id', supplierId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

// ============================================
// AI INSIGHTS
// ============================================

app.get('/api/ai-insights/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [{ data: invoices }, { data: calls }, { data: movements }, { data: products }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId),
      supabase.from('stock_movements').select('*, products(name)').eq('user_id', userId),
      supabase.from('products').select('*').eq('user_id', userId),
    ]);

    const safeInv = invoices || [];
    const safeCalls = calls || [];
    const safeMov = movements || [];
    const safeProd = products || [];

    // Customer stats
    const custMap = {};
    safeInv.forEach(inv => {
      if (!custMap[inv.customer_name]) custMap[inv.customer_name] = { name: inv.customer_name, total: 0, paid: 0, pending: 0, invoices: 0 };
      custMap[inv.customer_name].total += Number(inv.invoice_amount);
      custMap[inv.customer_name].invoices += 1;
      if (inv.payment_status === 'Paid') custMap[inv.customer_name].paid += Number(inv.payment_amount || inv.invoice_amount);
      else custMap[inv.customer_name].pending += Number(inv.invoice_amount);
    });
    const customers = Object.values(custMap).sort((a, b) => b.total - a.total);

    // Product sales from stock_movements out
    const prodMap = {};
    safeMov.filter(m => m.movement_type === 'out').forEach(m => {
      const name = m.products?.name || m.product_id;
      if (!prodMap[name]) prodMap[name] = { name, units_sold: 0 };
      prodMap[name].units_sold += m.quantity;
    });
    const productSales = Object.values(prodMap).sort((a, b) => b.units_sold - a.units_sold);

    // Call effectiveness
    const totalCalls = safeCalls.length;
    const pickedUp = safeCalls.filter(c => c.did_pick_up).length;
    const promised = safeCalls.filter(c => c.promised_payment_date).length;

    // Build context for Groq
    const context = `
Business Data Summary:
- Total invoices: ${safeInv.length}, Paid: ${safeInv.filter(i=>i.payment_status==='Paid').length}, Pending: ${safeInv.filter(i=>i.payment_status!=='Paid').length}
- Total outstanding: ₹${safeInv.filter(i=>i.payment_status!=='Paid').reduce((s,i)=>s+Number(i.invoice_amount),0).toLocaleString('en-IN')}
- Total collected: ₹${safeInv.filter(i=>i.payment_status==='Paid').reduce((s,i)=>s+Number(i.payment_amount||i.invoice_amount),0).toLocaleString('en-IN')}

Top customers by purchase value:
${customers.slice(0,5).map((c,i)=>`${i+1}. ${c.name}: ₹${c.total.toLocaleString('en-IN')} total, ₹${c.paid.toLocaleString('en-IN')} paid, ₹${c.pending.toLocaleString('en-IN')} pending`).join('\n')}

Lowest buying customers:
${customers.slice(-3).map((c,i)=>`${i+1}. ${c.name}: ₹${c.total.toLocaleString('en-IN')} total`).join('\n')}

Product sales (stock out movements):
${productSales.length ? productSales.map((p,i)=>`${i+1}. ${p.name}: ${p.units_sold} units sold`).join('\n') : 'No sales data yet'}

Products in inventory: ${safeProd.length}, Low stock: ${safeProd.filter(p=>p.current_stock>0&&p.current_stock<=p.low_stock_alert).length}, Out of stock: ${safeProd.filter(p=>p.current_stock===0).length}

Calls made: ${totalCalls}, Pick-up rate: ${totalCalls ? Math.round(pickedUp/totalCalls*100) : 0}%, Promises secured: ${promised}
`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'You are a sharp business analyst for Indian MSMEs. Given data, provide 4-5 specific, actionable insights in plain English. Be direct and data-driven. Format as a JSON array of objects: [{title, insight, action, type}] where type is "success"|"warning"|"danger"|"info". No markdown, pure JSON only.' },
          { role: 'user', content: context }
        ]
      })
    });
    const groqData = await response.json();
    let insights = [];
    try {
      const text = groqData.choices[0]?.message?.content || '[]';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      insights = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch(e) { insights = []; }

    res.json({
      success: true,
      stats: { customers: customers.slice(0,5), bottomCustomers: customers.slice(-3), productSales, totalCalls, pickedUp, promised },
      insights
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DEEP AI ANALYSIS (Groq llama-3.3-70b — free)
// ============================================

app.get('/api/ai-deep-analysis/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [{ data: invoices }, { data: calls }, { data: movements }, { data: products }, { data: suppliers }] = await Promise.all([
      supabase.from('invoices').select('*').eq('user_id', userId),
      supabase.from('call_logs').select('*').eq('user_id', userId),
      supabase.from('stock_movements').select('*, products(name)').eq('user_id', userId),
      supabase.from('products').select('*').eq('user_id', userId),
      supabase.from('suppliers').select('*').eq('user_id', userId),
    ]);

    const inv = invoices || [];
    const cls = calls || [];
    const mov = movements || [];
    const prd = products || [];
    const sup = suppliers || [];

    const paid = inv.filter(i => i.payment_status === 'Paid');
    const pending = inv.filter(i => i.payment_status !== 'Paid');
    const totalOutstanding = pending.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const totalRecovered = paid.reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount), 0);
    const recoveryRate = inv.length ? Math.round(paid.length / inv.length * 100) : 0;

    // Customer breakdown
    const custMap = {};
    inv.forEach(i => {
      if (!custMap[i.customer_name]) custMap[i.customer_name] = { name: i.customer_name, phone: i.customer_phone, total: 0, paid: 0, pending: 0, overdue: 0, invoices: 0 };
      custMap[i.customer_name].total += Number(i.invoice_amount);
      custMap[i.customer_name].invoices++;
      if (i.payment_status === 'Paid') custMap[i.customer_name].paid += Number(i.payment_amount || i.invoice_amount);
      else { custMap[i.customer_name].pending += Number(i.invoice_amount); custMap[i.customer_name].overdue = Math.max(custMap[i.customer_name].overdue, i.days_overdue); }
    });
    const customers = Object.values(custMap).sort((a, b) => b.pending - a.pending);

    const callsByCustomer = {};
    cls.forEach(c => {
      if (!callsByCustomer[c.customer_name]) callsByCustomer[c.customer_name] = { calls: 0, pickup: 0 };
      callsByCustomer[c.customer_name].calls++;
      if (c.did_pick_up) callsByCustomer[c.customer_name].pickup++;
    });

    const lowStock = prd.filter(p => p.current_stock > 0 && p.current_stock <= p.low_stock_alert);
    const outOfStock = prd.filter(p => p.current_stock === 0);
    const stockValue = prd.reduce((s, p) => s + (Number(p.unit_price) * Number(p.current_stock)), 0);

    const prompt = `You are a senior business analyst for Indian MSMEs. Analyze this business data and produce a comprehensive, honest, and actionable report.

BUSINESS DATA:
Business: Collections & Inventory Management

INVOICES:
- Total: ${inv.length} | Paid: ${paid.length} | Pending: ${pending.length}
- Outstanding: ₹${totalOutstanding.toLocaleString('en-IN')} | Recovered: ₹${totalRecovered.toLocaleString('en-IN')}
- Recovery Rate: ${recoveryRate}% (Industry avg: 40%)

CUSTOMERS (sorted by pending amount):
${customers.slice(0, 8).map(c => `- ${c.name}: ₹${c.pending.toLocaleString('en-IN')} pending, ₹${c.paid.toLocaleString('en-IN')} paid, overdue ${c.overdue} days, calls: ${callsByCustomer[c.name]?.calls || 0} (pickup: ${callsByCustomer[c.name]?.pickup || 0})`).join('\n')}

CALLS: ${cls.length} total, ${cls.filter(c => c.did_pick_up).length} picked up, ${cls.filter(c => c.promised_payment_date).length} payment promises secured

INVENTORY:
- Products: ${prd.length} | Stock Value: ₹${stockValue.toLocaleString('en-IN')}
- Low stock: ${lowStock.map(p => `${p.name} (${p.current_stock} left)`).join(', ') || 'none'}
- Out of stock: ${outOfStock.map(p => p.name).join(', ') || 'none'}
- Stock movements (out): ${mov.filter(m => m.movement_type === 'out').length} dispatches

SUPPLIERS: ${sup.length} suppliers on record

Return a JSON object with this exact structure (no markdown, pure JSON):
{
  "health_score": <number 0-100>,
  "health_label": <"Excellent"|"Good"|"Average"|"Needs Work"|"Critical">,
  "health_color": <"#16a34a"|"#65a30d"|"#d97706"|"#ea580c"|"#dc2626">,
  "executive_summary": "<2-3 sentences honest overview>",
  "top_actions": [
    {"priority": 1, "action": "<specific action>", "impact": "<expected result>", "urgency": "TODAY"|"THIS WEEK"|"THIS MONTH"}
  ],
  "sections": [
    {
      "id": "collections",
      "title": "💰 Collections Analysis",
      "insights": ["<specific insight with numbers>"],
      "customers": [{"name": "", "status": "CHASE NOW"|"FOLLOW UP"|"RELIABLE"|"RISKY", "reason": "", "suggested_action": ""}]
    },
    {
      "id": "cashflow",
      "title": "📊 Cash Flow Health",
      "insights": ["<specific insight>"],
      "metrics": [{"label": "", "value": "", "trend": "up"|"down"|"neutral"}]
    },
    {
      "id": "inventory",
      "title": "📦 Inventory Intelligence",
      "insights": ["<specific insight>"],
      "alerts": [{"product": "", "issue": "", "action": ""}]
    },
    {
      "id": "strategy",
      "title": "🎯 This Week's Strategy",
      "insights": ["<specific actionable step with expected outcome>"]
    },
    {
      "id": "risks",
      "title": "⚠️ Risks & Warnings",
      "insights": ["<specific risk>"]
    }
  ]
}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a senior business analyst for Indian MSMEs. Always respond with valid JSON only — no markdown, no explanation, just the JSON object.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const text = data.choices?.[0]?.message?.content || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Deep analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CAMERA / OCR SCAN
// ============================================

app.post('/api/scan-document', async (req, res) => {
  const { image_base64, scan_type } = req.body; // scan_type: 'invoice' | 'supplier'
  if (!image_base64) return res.status(400).json({ error: 'No image provided' });

  const invoicePrompt = `Extract invoice/bill details from this image. Return ONLY a JSON object with these fields (use null if not found):
{"customer_name": "", "customer_phone": "", "invoice_amount": null, "invoice_date": "YYYY-MM-DD", "items": "brief description of items"}`;

  const supplierPrompt = `Extract supplier/vendor details from this document image. Return ONLY a JSON object with these fields (use null if not found):
{"name": "", "phone": "", "email": "", "address": "", "payment_terms": null}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 400,
        messages: [
          { role: 'user', content: [
            { type: 'text', text: scan_type === 'supplier' ? supplierPrompt : invoicePrompt },
            { type: 'image_url', image_url: { url: image_base64 } }
          ]}
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Vision API error');
    const text = data.choices[0]?.message?.content || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    res.json({ success: true, extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend is running', timestamp: new Date() });
});

// ============================================
// SEED DEMO DATA
// ============================================

app.post('/api/seed/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Verify user exists
    const { data: user, error: userErr } = await supabase
      .from('users').select('id').eq('id', userId).single();
    if (userErr || !user) return res.status(404).json({ error: 'User not found' });

    const today = new Date();
    const daysAgo = (n) => {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d.toISOString().split('T')[0];
    };

    // --- INVOICES ---
    const invoices = [
      { user_id: userId, customer_name: 'Ramesh Traders', customer_phone: '9876543210', invoice_amount: 45000, invoice_date: daysAgo(62), payment_status: 'Pending', days_overdue: 62 },
      { user_id: userId, customer_name: 'Sunita Enterprises', customer_phone: '9823456789', invoice_amount: 28500, invoice_date: daysAgo(47), payment_status: 'Pending', days_overdue: 47 },
      { user_id: userId, customer_name: 'Kapoor & Sons', customer_phone: '9765432100', invoice_amount: 72000, invoice_date: daysAgo(38), payment_status: 'Pending', days_overdue: 38 },
      { user_id: userId, customer_name: 'Meena Stores', customer_phone: '9812345678', invoice_amount: 15000, invoice_date: daysAgo(31), payment_status: 'Pending', days_overdue: 31 },
      { user_id: userId, customer_name: 'Vijay Hardware', customer_phone: '9988776655', invoice_amount: 33500, invoice_date: daysAgo(22), payment_status: 'Pending', days_overdue: 22 },
      { user_id: userId, customer_name: 'Priya Textiles', customer_phone: '9001234567', invoice_amount: 19000, invoice_date: daysAgo(15), payment_status: 'Pending', days_overdue: 15 },
      { user_id: userId, customer_name: 'Ashok Medical', customer_phone: '9112233445', invoice_amount: 8500,  invoice_date: daysAgo(7),  payment_status: 'Pending', days_overdue: 7  },
      { user_id: userId, customer_name: 'Gupta Electricals', customer_phone: '9556677889', invoice_amount: 52000, invoice_date: daysAgo(55), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(20), payment_amount: 52000, payment_method: 'UPI', payment_notes: 'Paid via GPay' },
      { user_id: userId, customer_name: 'Lakshmi Garments', customer_phone: '9443322110', invoice_amount: 24000, invoice_date: daysAgo(40), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(10), payment_amount: 24000, payment_method: 'Bank Transfer' },
      { user_id: userId, customer_name: 'Sharma General Store', customer_phone: '9334455667', invoice_amount: 11000, invoice_date: daysAgo(18), payment_status: 'Paid', days_overdue: 0, payment_date: daysAgo(5), payment_amount: 11000, payment_method: 'Cash' },
    ];

    const { data: invData, error: invErr } = await supabase.from('invoices').insert(invoices).select();
    if (invErr) throw invErr;

    // Map customer name → invoice id for call logs
    const invMap = {};
    invData.forEach(i => { invMap[i.customer_name] = i.id; });

    // --- CALL LOGS ---
    const callLogs = [
      { user_id: userId, invoice_id: invMap['Ramesh Traders'],    customer_name: 'Ramesh Traders',    customer_phone: '9876543210', amount: 45000, did_pick_up: true,  call_duration_minutes: 6, promised_payment_date: daysAgo(-3), promised_amount: 45000, notes: 'Promised to pay by end of week. Said he is waiting for his own payment.' },
      { user_id: userId, invoice_id: invMap['Sunita Enterprises'],customer_name: 'Sunita Enterprises',customer_phone: '9823456789', amount: 28500, did_pick_up: false, call_duration_minutes: 0, notes: 'No answer. Tried twice.' },
      { user_id: userId, invoice_id: invMap['Kapoor & Sons'],     customer_name: 'Kapoor & Sons',     customer_phone: '9765432100', amount: 72000, did_pick_up: true,  call_duration_minutes: 12, promised_payment_date: daysAgo(-7), promised_amount: 36000, notes: 'Agreed to pay 50% now, rest in 2 weeks.' },
      { user_id: userId, invoice_id: invMap['Meena Stores'],      customer_name: 'Meena Stores',      customer_phone: '9812345678', amount: 15000, did_pick_up: true,  call_duration_minutes: 3, notes: 'Disputed 2000 in charges. Will verify and pay rest.' },
      { user_id: userId, invoice_id: invMap['Vijay Hardware'],    customer_name: 'Vijay Hardware',    customer_phone: '9988776655', amount: 33500, did_pick_up: false, call_duration_minutes: 0, notes: 'Phone switched off.' },
      { user_id: userId, invoice_id: invMap['Ramesh Traders'],    customer_name: 'Ramesh Traders',    customer_phone: '9876543210', amount: 45000, did_pick_up: true,  call_duration_minutes: 4, notes: 'Follow-up call. He asked for 3 more days.' },
    ];

    const { error: callErr } = await supabase.from('call_logs').insert(callLogs);
    if (callErr) throw callErr;

    // --- SUPPLIERS ---
    const suppliers = [
      { user_id: userId, name: 'National Steel Works',   phone: '9111222333', email: 'sales@nationalsteel.in',   address: '14, Industrial Area, Pune', payment_terms: 30 },
      { user_id: userId, name: 'Bharat Polymers Ltd',    phone: '9222333444', email: 'orders@bharatpolymers.com', address: 'MIDC Phase 2, Nashik',      payment_terms: 45 },
      { user_id: userId, name: 'Rajasthan Textile Mill', phone: '9333444555', email: 'info@rjtextile.co.in',      address: 'Jodhpur Industrial Estate',  payment_terms: 15 },
      { user_id: userId, name: 'Delhi Packaging Co',     phone: '9444555666', email: 'delhi@packagingco.in',      address: 'Okhla Phase 3, New Delhi',   payment_terms: 30 },
    ];

    const { error: supErr } = await supabase.from('suppliers').insert(suppliers);
    if (supErr) throw supErr;

    // --- PRODUCTS ---
    const products = [
      { user_id: userId, name: 'Steel Rods 12mm',    sku: 'STL-001', category: 'Raw Material', unit: 'kg',     unit_price: 85,   current_stock: 450,  low_stock_alert: 100 },
      { user_id: userId, name: 'Polypropylene Bags', sku: 'PKG-002', category: 'Packaging',    unit: 'pcs',    unit_price: 12,   current_stock: 1200, low_stock_alert: 200 },
      { user_id: userId, name: 'Cotton Fabric Roll', sku: 'TEX-003', category: 'Raw Material', unit: 'meters', unit_price: 145,  current_stock: 80,   low_stock_alert: 100 },
      { user_id: userId, name: 'Cardboard Boxes L',  sku: 'PKG-004', category: 'Packaging',    unit: 'pcs',    unit_price: 28,   current_stock: 0,    low_stock_alert: 50  },
      { user_id: userId, name: 'Machine Oil 5L',     sku: 'MNT-005', category: 'Maintenance',  unit: 'cans',   unit_price: 550,  current_stock: 18,   low_stock_alert: 5   },
      { user_id: userId, name: 'Safety Gloves',      sku: 'SAF-006', category: 'Safety',       unit: 'pairs',  unit_price: 75,   current_stock: 35,   low_stock_alert: 20  },
    ];

    const { data: prodData, error: prodErr } = await supabase.from('products').insert(products).select();
    if (prodErr) throw prodErr;

    // --- STOCK MOVEMENTS ---
    const moves = [
      { user_id: userId, product_id: prodData[0].id, movement_type: 'in',  quantity: 500,  unit_cost: 82, reference: 'PO-2024-001', notes: 'Received from National Steel' },
      { user_id: userId, product_id: prodData[0].id, movement_type: 'out', quantity: 50,   reference: 'SO-2024-011', notes: 'Dispatched to Ramesh Traders' },
      { user_id: userId, product_id: prodData[1].id, movement_type: 'in',  quantity: 1500, unit_cost: 11, reference: 'PO-2024-002', notes: 'Received from Bharat Polymers' },
      { user_id: userId, product_id: prodData[1].id, movement_type: 'out', quantity: 300,  reference: 'SO-2024-015', notes: 'Packaging for Kapoor & Sons order' },
      { user_id: userId, product_id: prodData[2].id, movement_type: 'in',  quantity: 150,  unit_cost: 140, reference: 'PO-2024-003', notes: 'From Rajasthan Textile Mill' },
      { user_id: userId, product_id: prodData[2].id, movement_type: 'out', quantity: 70,   reference: 'SO-2024-018', notes: 'Priya Textiles order' },
      { user_id: userId, product_id: prodData[3].id, movement_type: 'in',  quantity: 200,  unit_cost: 26, reference: 'PO-2024-004' },
      { user_id: userId, product_id: prodData[3].id, movement_type: 'out', quantity: 200,  reference: 'SO-2024-020', notes: 'All boxes dispatched' },
    ];

    const { error: movErr } = await supabase.from('stock_movements').insert(moves);
    if (movErr) throw movErr;

    res.json({
      success: true,
      seeded: {
        invoices: invData.length,
        calls: callLogs.length,
        suppliers: suppliers.length,
        products: prodData.length,
        movements: moves.length
      }
    });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PROSPECTS / CRM LITE
// ============================================

app.get('/api/prospects/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { data, error } = await supabase
      .from('prospects')
      .select('*, prospect_notes(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, prospects: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects', async (req, res) => {
  try {
    const { user_id, name, phone, email, business_type, location, amount_stuck, status } = req.body;
    const { data, error } = await supabase
      .from('prospects')
      .insert([{ user_id, name, phone, email, business_type, location, amount_stuck: amount_stuck || null, status: status || 'cold' }])
      .select();
    if (error) throw error;
    res.json({ success: true, prospect: data[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const updates = req.body;
    updates.updated_at = new Date();
    if (updates.status === 'trial' && !updates.trial_start_date) {
      updates.trial_start_date = new Date().toISOString().split('T')[0];
      const end = new Date(); end.setDate(end.getDate() + 14);
      updates.trial_end_date = end.toISOString().split('T')[0];
    }
    const { data, error } = await supabase.from('prospects').update(updates).eq('id', id).select();
    if (error) throw error;
    res.json({ success: true, prospect: data[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('prospects').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects/:id/notes', async (req, res) => {
  const { id } = req.params;
  try {
    const { text } = req.body;
    const { data, error } = await supabase
      .from('prospect_notes')
      .insert([{ prospect_id: id, text }])
      .select();
    if (error) throw error;
    res.json({ success: true, note: data[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// CASH FLOW FORECAST
// ============================================

app.get('/api/cash-forecast/:userId', async (req, res) => {
  const { userId } = req.params;
  const { current_cash = 0, daily_expenses = 13000, days = 30 } = req.query;

  try {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('invoice_amount, payment_amount, payment_status, payment_date, days_overdue, customer_name')
      .eq('user_id', userId);

    const safe = invoices || [];
    const paid = safe.filter(i => i.payment_status === 'Paid' && i.payment_date);
    const totalRecovered = paid.reduce((s, i) => s + Number(i.payment_amount || i.invoice_amount), 0);
    const pending = safe.filter(i => i.payment_status !== 'Paid');
    const totalOutstanding = pending.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const totalOverdue30 = pending.filter(i => Number(i.days_overdue) >= 30)
      .reduce((s, i) => s + Number(i.invoice_amount), 0);

    // Average daily collections over last 90 days (or estimate from outstanding if not enough data)
    const avgDailyCollections = paid.length > 0 ? Math.round(totalRecovered / 90) : Math.round(totalOutstanding * 0.03);

    const cashStart = Number(current_cash);
    const burnRate = Number(daily_expenses);
    const n = Number(days);

    const buildCurve = (inflow) => {
      const curve = [];
      let cash = cashStart;
      for (let d = 0; d <= n; d++) {
        curve.push({ day: d, cash: Math.max(0, Math.round(cash)) });
        cash += inflow - burnRate;
      }
      return curve;
    };

    const scenarios = {
      pessimistic: { dailyInflow: Math.round(avgDailyCollections * 0.5) },
      expected:    { dailyInflow: Math.round(avgDailyCollections * 0.8) },
      optimistic:  { dailyInflow: Math.round(avgDailyCollections * 0.95) },
    };

    Object.keys(scenarios).forEach(k => {
      const { dailyInflow } = scenarios[k];
      const netDaily = dailyInflow - burnRate;
      scenarios[k].curve = buildCurve(dailyInflow);
      scenarios[k].endCash = Math.max(0, Math.round(cashStart + netDaily * n));
      scenarios[k].runwayDays = netDaily >= 0 ? 999 : Math.floor(cashStart / Math.abs(netDaily));
    });

    res.json({
      success: true,
      cashStart,
      burnRate,
      avgDailyCollections,
      totalOutstanding,
      totalOverdue30,
      scenarios,
      days: n
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// DB MIGRATION (safe to call multiple times)
// ============================================

app.post('/api/migrate', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(400).json({
      error: 'DATABASE_URL not set',
      instructions: 'Set DATABASE_URL in Railway environment variables to your Supabase PostgreSQL connection string (find it at: Supabase dashboard → Settings → Database → Connection string → URI mode)',
      sql: `CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  business_type TEXT DEFAULT 'Distributor',
  location TEXT,
  amount_stuck NUMERIC,
  status TEXT DEFAULT 'cold',
  trial_start_date DATE,
  trial_end_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS prospect_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prospects_user_id ON prospects(user_id);
CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect_id ON prospect_notes(prospect_id);`
    });
  }

  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        business_type TEXT DEFAULT 'Distributor',
        location TEXT,
        amount_stuck NUMERIC,
        status TEXT DEFAULT 'cold',
        trial_start_date DATE,
        trial_end_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prospect_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospects_user_id ON prospects(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_prospect_notes_prospect_id ON prospect_notes(prospect_id)`);

    await client.end();
    res.json({ success: true, message: '✅ Migration complete — prospects & prospect_notes tables created' });
  } catch (err) {
    if (client) await client.end().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AI CHAT ASSISTANT (Groq tool-calling — free)
// ============================================

const AI_TOOLS = [
  { type:'function', function:{ name:'get_summary', description:'Get business overview: total invoices, outstanding amount, recovery rate, total customers', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'get_invoices', description:'Get invoices list, optionally filtered by status or customer name', parameters:{ type:'object', properties:{ status:{ type:'string', description:'Pending, Paid, or all' }, customer_name:{ type:'string', description:'Filter by customer (partial match)' }, limit:{ type:'number', description:'Max records to return' } } } } },
  { type:'function', function:{ name:'mark_invoice_paid', description:'Mark a specific invoice as paid using invoice_id or customer_name (marks the most overdue one)', parameters:{ type:'object', properties:{ invoice_id:{ type:'string' }, customer_name:{ type:'string' } } } } },
  { type:'function', function:{ name:'get_prospects', description:'Get CRM prospects, optionally filtered by stage', parameters:{ type:'object', properties:{ status:{ type:'string', description:'cold, contacted, trial, engaged, paid, churned, or all' } } } } },
  { type:'function', function:{ name:'add_prospect', description:'Add a new prospect to the CRM pipeline', parameters:{ type:'object', properties:{ name:{ type:'string' }, phone:{ type:'string' }, business_type:{ type:'string' }, location:{ type:'string' }, amount_stuck:{ type:'number' } }, required:['name'] } } },
  { type:'function', function:{ name:'update_prospect_status', description:'Move a prospect to a different CRM stage', parameters:{ type:'object', properties:{ prospect_name:{ type:'string', description:'Name of the prospect to update' }, status:{ type:'string', enum:['cold','contacted','trial','engaged','paid','churned'] } }, required:['prospect_name','status'] } } },
  { type:'function', function:{ name:'get_inventory', description:'Get product inventory levels, low stock alerts, and stock value', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'get_calls', description:'Get recent call history and performance stats', parameters:{ type:'object', properties:{ limit:{ type:'number' } } } } },
  { type:'function', function:{ name:'get_cash_forecast', description:'Get 3-scenario cash flow forecast for the next N days', parameters:{ type:'object', properties:{ days:{ type:'number', description:'Forecast horizon in days (14/30/60/90)' } } } } },
  { type:'function', function:{ name:'get_overdue', description:'Get customers with overdue invoices sorted by days overdue or amount', parameters:{ type:'object', properties:{ min_days:{ type:'number', description:'Minimum days overdue (e.g. 30)' } } } } },
  { type:'function', function:{ name:'navigate_to', description:'Navigate the user to a specific page in the app', parameters:{ type:'object', properties:{ page:{ type:'string', enum:['dashboard','payments','calls','priority','message','analytics','inventory','metrics','prospects','forecast','pricing'] }, reason:{ type:'string', description:'Why you are navigating there' } }, required:['page'] } } },
  { type:'function', function:{ name:'get_suppliers', description:'Get all suppliers with name, phone, email, payment terms', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'send_whatsapp', description:'Compose and prepare a WhatsApp message to any contact (customer or supplier). The message will be opened ready-to-send in WhatsApp.', parameters:{ type:'object', properties:{ to:{ type:'string', description:'Recipient name' }, phone:{ type:'string', description:'Phone number (digits only or with spaces)' }, message:{ type:'string', description:'The full message text — write it naturally in Hindi/English mix if appropriate' } }, required:['to','phone','message'] } } },
  { type:'function', function:{ name:'send_collection_reminder', description:'Compose a tailored payment reminder WhatsApp message for an overdue customer', parameters:{ type:'object', properties:{ customer_name:{ type:'string' }, tone:{ type:'string', enum:['friendly','firm','urgent'], description:'Tone of the message' } }, required:['customer_name'] } } },
  { type:'function', function:{ name:'send_bulk_reminders', description:'Prepare WhatsApp payment reminders for ALL overdue customers at once (or filtered by min days overdue)', parameters:{ type:'object', properties:{ min_days:{ type:'number', description:'Only customers overdue by at least this many days (default 1)' }, tone:{ type:'string', enum:['friendly','firm','urgent'] } } } } },
  { type:'function', function:{ name:'place_order_with_supplier', description:'Create a purchase order for a supplier and compose a WhatsApp order message to them', parameters:{ type:'object', properties:{ supplier_name:{ type:'string', description:'Name of the supplier' }, items:{ type:'array', items:{ type:'object', properties:{ name:{type:'string'}, quantity:{type:'number'}, unit:{type:'string',description:'e.g. boxes, kg, units'} } }, description:'Items to order' }, notes:{ type:'string', description:'Any special instructions' } }, required:['supplier_name','items'] } } },
];

async function groqChat(messages, tools, toolChoice = 'auto') {
  const body = { model:'llama-3.3-70b-versatile', max_tokens:1500, temperature:0.2, messages };
  if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice; }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq error');
  return data.choices[0];
}

app.post('/api/ai-chat', async (req, res) => {
  const { user_id, messages, business_name } = req.body;
  if (!user_id || !messages) return res.status(400).json({ error: 'Missing user_id or messages' });

  const system = `You are Vantro AI, an intelligent business assistant built into the Vantro Flow app for ${business_name || 'this business'}. You help Indian MSME distributors manage collections, invoices, CRM prospects, inventory, and cash flow.

You have tools to: fetch data, mark invoices as paid, add/update prospects, get forecasts, and navigate pages.
Always be helpful, specific, and use rupee (₹) formatting. When asked to do something, use tools to actually do it — don't just explain.
After performing actions, summarise what you did clearly. Keep responses concise and friendly.`;

  const chatMessages = [
    { role:'system', content: system },
    ...messages
  ];

  const actions = [];
  const waLinks = [];
  let navigateTo = null;

  const executeTool = async (name, args) => {
    try {
      switch(name) {
        case 'get_summary': {
          const { data:inv } = await supabase.from('invoices').select('invoice_amount,payment_status,days_overdue').eq('user_id', user_id);
          const safe = inv || [];
          const paid = safe.filter(i=>i.payment_status==='Paid');
          const pending = safe.filter(i=>i.payment_status!=='Paid');
          const outstanding = pending.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const recovered = paid.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const { data:cust } = await supabase.from('invoices').select('customer_name').eq('user_id',user_id);
          const uniqueCustomers = new Set((cust||[]).map(c=>c.customer_name)).size;
          return { total_invoices:safe.length, paid:paid.length, pending:pending.length, outstanding:`₹${outstanding.toLocaleString('en-IN')}`, recovered:`₹${recovered.toLocaleString('en-IN')}`, recovery_rate:`${safe.length?Math.round(paid.length/safe.length*100):0}%`, total_customers:uniqueCustomers };
        }
        case 'get_invoices': {
          let q = supabase.from('invoices').select('id,customer_name,customer_phone,invoice_amount,payment_status,days_overdue,invoice_date').eq('user_id',user_id);
          if (args.status && args.status!=='all') q = q.eq('payment_status', args.status);
          if (args.customer_name) q = q.ilike('customer_name', `%${args.customer_name}%`);
          q = q.order('days_overdue',{ascending:false}).limit(args.limit||20);
          const { data } = await q;
          return data || [];
        }
        case 'mark_invoice_paid': {
          let inv;
          if (args.invoice_id) {
            const { data } = await supabase.from('invoices').select('id,customer_name,invoice_amount').eq('id',args.invoice_id).single();
            inv = data;
          } else if (args.customer_name) {
            const { data } = await supabase.from('invoices').select('id,customer_name,invoice_amount').eq('user_id',user_id).ilike('customer_name',`%${args.customer_name}%`).eq('payment_status','Pending').order('days_overdue',{ascending:false}).limit(1);
            inv = data?.[0];
          }
          if (!inv) return { error: 'Invoice not found' };
          await supabase.from('invoices').update({ payment_status:'Paid', payment_date:new Date().toISOString().split('T')[0], payment_amount:inv.invoice_amount }).eq('id',inv.id);
          actions.push(`✅ Marked ${inv.customer_name} invoice (₹${Number(inv.invoice_amount).toLocaleString('en-IN')}) as paid`);
          return { success:true, message:`Marked ${inv.customer_name} as paid`, amount:inv.invoice_amount };
        }
        case 'get_prospects': {
          let q = supabase.from('prospects').select('id,name,phone,status,business_type,location,amount_stuck,created_at').eq('user_id',user_id);
          if (args.status && args.status!=='all') q = q.eq('status',args.status);
          const { data } = await q.order('created_at',{ascending:false});
          return data || [];
        }
        case 'add_prospect': {
          const { data, error } = await supabase.from('prospects').insert([{ user_id, name:args.name, phone:args.phone||null, business_type:args.business_type||'Distributor', location:args.location||null, amount_stuck:args.amount_stuck||null, status:'cold' }]).select();
          if (error) return { error: error.message };
          actions.push(`➕ Added prospect: ${args.name} to CRM`);
          return { success:true, prospect: data[0] };
        }
        case 'update_prospect_status': {
          const { data:prospects } = await supabase.from('prospects').select('id,name,status').eq('user_id',user_id).ilike('name',`%${args.prospect_name}%`).limit(1);
          const p = prospects?.[0];
          if (!p) return { error: `Prospect "${args.prospect_name}" not found` };
          const updates = { status:args.status, updated_at:new Date() };
          if (args.status==='trial') { updates.trial_start_date=new Date().toISOString().split('T')[0]; const e=new Date(); e.setDate(e.getDate()+14); updates.trial_end_date=e.toISOString().split('T')[0]; }
          await supabase.from('prospects').update(updates).eq('id',p.id);
          actions.push(`🔄 Moved ${p.name} → ${args.status}`);
          return { success:true, message:`${p.name} moved to ${args.status}` };
        }
        case 'get_inventory': {
          const { data:products } = await supabase.from('products').select('*').eq('user_id',user_id);
          const prd = products||[];
          const lowStock = prd.filter(p=>p.current_stock>0&&p.current_stock<=p.low_stock_alert);
          const outOfStock = prd.filter(p=>p.current_stock===0);
          const stockValue = prd.reduce((s,p)=>s+(Number(p.unit_price)*Number(p.current_stock)),0);
          return { total_products:prd.length, stock_value:`₹${stockValue.toLocaleString('en-IN')}`, low_stock:lowStock.map(p=>({name:p.name,stock:p.current_stock,alert:p.low_stock_alert})), out_of_stock:outOfStock.map(p=>p.name), products:prd.map(p=>({name:p.name,stock:p.current_stock,unit_price:`₹${p.unit_price}`})) };
        }
        case 'get_calls': {
          const { data } = await supabase.from('call_logs').select('customer_name,did_pick_up,notes,promised_payment_date,created_at').eq('user_id',user_id).order('created_at',{ascending:false}).limit(args.limit||15);
          const cls = data||[];
          const pickupRate = cls.length ? Math.round(cls.filter(c=>c.did_pick_up).length/cls.length*100) : 0;
          return { total:cls.length, pickup_rate:`${pickupRate}%`, promises:cls.filter(c=>c.promised_payment_date).length, recent:cls.slice(0,10) };
        }
        case 'get_cash_forecast': {
          const days = args.days||30;
          const { data:invoices } = await supabase.from('invoices').select('invoice_amount,payment_status,payment_date').eq('user_id',user_id);
          const safe = invoices||[];
          const paid = safe.filter(i=>i.payment_status==='Paid'&&i.payment_date);
          const totalRecovered = paid.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const outstanding = safe.filter(i=>i.payment_status!=='Paid').reduce((s,i)=>s+Number(i.invoice_amount),0);
          const avgDaily = paid.length>0?Math.round(totalRecovered/90):Math.round(outstanding*0.03);
          return { forecast_days:days, avg_daily_collections:`₹${avgDaily.toLocaleString('en-IN')}`, total_outstanding:`₹${outstanding.toLocaleString('en-IN')}`, pessimistic_day_n:`₹${Math.round(avgDaily*0.5*days).toLocaleString('en-IN')}`, expected_day_n:`₹${Math.round(avgDaily*0.8*days).toLocaleString('en-IN')}`, optimistic_day_n:`₹${Math.round(avgDaily*0.95*days).toLocaleString('en-IN')}` };
        }
        case 'get_overdue': {
          let q = supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id',user_id).eq('payment_status','Pending').order('days_overdue',{ascending:false});
          if (args.min_days) q = q.gte('days_overdue',args.min_days);
          const { data } = await q.limit(20);
          return data||[];
        }
        case 'navigate_to': {
          navigateTo = args.page;
          actions.push(`🧭 Navigating to ${args.page}`);
          return { success:true, navigating_to:args.page, reason:args.reason };
        }
        case 'get_suppliers': {
          const { data } = await supabase.from('suppliers').select('*').eq('user_id', user_id);
          return data || [];
        }
        case 'send_whatsapp': {
          const phone = String(args.phone||'').replace(/\D/g,'');
          if (!phone) return { error: 'No phone number provided' };
          const url = `https://wa.me/91${phone}?text=${encodeURIComponent(args.message)}`;
          waLinks.push({ to: args.to, phone, message: args.message, url });
          actions.push(`💬 WhatsApp ready for ${args.to}`);
          return { success:true, whatsapp_url: url, to: args.to, message_preview: args.message.substring(0,80) };
        }
        case 'send_collection_reminder': {
          // Fetch customer invoice data
          const { data: inv } = await supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id', user_id).ilike('customer_name', `%${args.customer_name}%`).eq('payment_status','Pending').order('days_overdue',{ascending:false}).limit(5);
          if (!inv?.length) return { error: `No pending invoices found for ${args.customer_name}` };
          const total = inv.reduce((s,i)=>s+Number(i.invoice_amount),0);
          const maxOverdue = Math.max(...inv.map(i=>Number(i.days_overdue)));
          const phone = String(inv[0].customer_phone||'').replace(/\D/g,'');
          const name = inv[0].customer_name;
          const tone = args.tone || 'friendly';
          let msg;
          if (tone === 'friendly') {
            msg = `Namaste ${name} ji 🙏\n\nAapke account mein ₹${total.toLocaleString('en-IN')} outstanding hai (${maxOverdue} din se).\n\nKripya jaldi payment karlein. Koi problem ho toh batayein, hum help karenge.\n\nDhanyawaad 🙏\n— ${business_name || 'Vantro Flow'}`;
          } else if (tone === 'firm') {
            msg = `Dear ${name},\n\nYe aapko yaad dilaana hai ki ₹${total.toLocaleString('en-IN')} ki payment ${maxOverdue} din se pending hai.\n\nKripya aaj hi payment karein ya 2 din mein confirm karein.\n\n— ${business_name || 'Vantro Flow'}`;
          } else {
            msg = `URGENT: ${name} ji, ₹${total.toLocaleString('en-IN')} ki payment ${maxOverdue} din overdue hai. Aaj payment nahi hui toh delivery ruk sakti hai. Turant sampark karein.\n— ${business_name || 'Vantro Flow'}`;
          }
          const url = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` : null;
          if (url) { waLinks.push({ to: name, phone, message: msg, url }); actions.push(`💬 Reminder ready for ${name}`); }
          return { success:true, customer: name, amount: `₹${total.toLocaleString('en-IN')}`, days_overdue: maxOverdue, message_preview: msg.substring(0,100), whatsapp_url: url, note: url ? 'WhatsApp link ready' : 'No phone number on file' };
        }
        case 'send_bulk_reminders': {
          const minDays = args.min_days || 1;
          const tone = args.tone || 'friendly';
          const { data: inv } = await supabase.from('invoices').select('customer_name,customer_phone,invoice_amount,days_overdue').eq('user_id', user_id).eq('payment_status','Pending').gte('days_overdue', minDays).order('days_overdue',{ascending:false});
          if (!inv?.length) return { message: 'No overdue invoices found matching criteria' };
          // Group by customer
          const custMap = {};
          inv.forEach(i => {
            if (!custMap[i.customer_name]) custMap[i.customer_name] = { name:i.customer_name, phone:i.customer_phone, total:0, maxOverdue:0 };
            custMap[i.customer_name].total += Number(i.invoice_amount);
            custMap[i.customer_name].maxOverdue = Math.max(custMap[i.customer_name].maxOverdue, Number(i.days_overdue));
          });
          const customers = Object.values(custMap);
          let added = 0;
          customers.forEach(c => {
            const phone = String(c.phone||'').replace(/\D/g,'');
            if (!phone) return;
            let msg;
            if (tone === 'urgent') {
              msg = `URGENT: ${c.name} ji, ₹${c.total.toLocaleString('en-IN')} ki payment ${c.maxOverdue} din se overdue hai. Aaj payment karein.\n— ${business_name||''}`;
            } else if (tone === 'firm') {
              msg = `Dear ${c.name}, ₹${c.total.toLocaleString('en-IN')} ki payment ${c.maxOverdue} din se pending hai. Kripya jaldi karein.\n— ${business_name||''}`;
            } else {
              msg = `Namaste ${c.name} ji 🙏 ₹${c.total.toLocaleString('en-IN')} outstanding hai (${c.maxOverdue} din). Kripya payment karein. Dhanyawaad!\n— ${business_name||''}`;
            }
            waLinks.push({ to: c.name, phone, message: msg, url: `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` });
            added++;
          });
          actions.push(`💬 ${added} WhatsApp reminders ready`);
          return { success:true, total_customers: customers.length, reminders_prepared: added, no_phone: customers.length - added };
        }
        case 'place_order_with_supplier': {
          // Find supplier
          const { data: suppliers } = await supabase.from('suppliers').select('*').eq('user_id', user_id).ilike('name', `%${args.supplier_name}%`).limit(1);
          const supplier = suppliers?.[0];
          const phone = supplier?.phone ? String(supplier.phone).replace(/\D/g,'') : null;
          // Compose order message
          const itemLines = (args.items||[]).map(it=>`  • ${it.name} — ${it.quantity} ${it.unit||'units'}`).join('\n');
          const totalItems = (args.items||[]).length;
          const msg = `Namaste ${args.supplier_name} ji 🙏\n\nHumein aapki taraf se yeh order chahiye:\n\n${itemLines}\n\n${args.notes ? `Note: ${args.notes}\n\n` : ''}Kripya availability aur delivery time confirm karein.\n\nDhanyawaad!\n— ${business_name||'Vantro Flow'}`;
          // Log as stock movement "ordered"
          if (supplier) {
            for (const item of (args.items||[])) {
              const { data: prod } = await supabase.from('products').select('id,name').eq('user_id',user_id).ilike('name',`%${item.name}%`).limit(1);
              if (prod?.[0]) {
                await supabase.from('stock_movements').insert([{ user_id, product_id:prod[0].id, movement_type:'order', quantity:item.quantity, notes:`Order placed with ${args.supplier_name}${args.notes?'. '+args.notes:''}`, created_at:new Date() }]).catch(()=>{});
              }
            }
          }
          const url = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` : null;
          if (url) { waLinks.push({ to: args.supplier_name, phone, message: msg, url }); actions.push(`📦 Order WhatsApp ready for ${args.supplier_name}`); }
          else { actions.push(`📦 Order composed for ${args.supplier_name} (no phone on file)`); }
          return { success:true, supplier: args.supplier_name, items_ordered: totalItems, message_preview: msg.substring(0,120), whatsapp_url: url || 'No phone number on file for this supplier', order_logged: !!supplier };
        }
        default: return { error:`Unknown tool: ${name}` };
      }
    } catch(err) { return { error: err.message }; }
  };

  try {
    let iteration = 0;
    const maxIter = 5;

    while (iteration < maxIter) {
      iteration++;
      const choice = await groqChat(chatMessages, AI_TOOLS);
      const msg = choice.message;
      chatMessages.push(msg);

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
        const toolResults = [];
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments||'{}'); } catch(e) {}
          const result = await executeTool(tc.function.name, args);
          toolResults.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(result) });
        }
        chatMessages.push(...toolResults);
      } else {
        return res.json({ success:true, message:msg.content, actions, navigate:navigateTo, waLinks });
      }
    }

    return res.json({ success:true, message:'Done! Let me know if you need anything else.', actions, navigate:navigateTo, waLinks });
  } catch(err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`✅ Vantro Flow Backend running on port ${PORT}`);
  console.log(`📝 API Base URL: http://localhost:${PORT}`);
});
