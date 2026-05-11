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
// DEEP AI ANALYSIS (Claude Opus 4.7)
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    const text = data.content?.find(b => b.type === 'text')?.text || '{}';
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
  try {
    // prospects table
    await supabase.rpc('exec_sql', { sql: `
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
      );
    `}).catch(() => null);

    await supabase.rpc('exec_sql', { sql: `
      CREATE TABLE IF NOT EXISTS prospect_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `}).catch(() => null);

    // Try direct insert to test table existence
    const { error: testErr } = await supabase.from('prospects').select('id').limit(1);
    if (testErr && testErr.code === '42P01') {
      return res.status(500).json({ error: 'Tables not created — please create them manually in Supabase dashboard', sql: `
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
);
CREATE TABLE IF NOT EXISTS prospect_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`});
    }

    res.json({ success: true, message: 'Migration complete — prospects & prospect_notes tables ready' });
  } catch (err) {
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
