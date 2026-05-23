// FILE: server.js
// VANTRO FLOW BACKEND - Complete Node.js + Express API
// Deploy to: Railway.app

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const JWT_SECRET = process.env.JWT_SECRET || 'vantro-dev-secret-change-in-prod';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
const extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Allow localhost dev
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return callback(null, true);
    // Allow all Vercel preview and production URLs
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow any explicitly listed extra origins
    if (extraOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.options('*', cors());

// Raw body preservation for Razorpay webhook (must come BEFORE express.json)
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { req.rawBody = data; next(); });
  } else {
    next();
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // Twilio webhooks send form-encoded

// Rate limiting
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Rate limit exceeded' } });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// JWT middleware — attach user to req if token valid
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Razorpay instance (initialised lazily so missing keys don't crash startup)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

const upload = multer({ storage: multer.memoryStorage() });

// Web Push — VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'hello@vantroflow.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, phone, business_name, password, referred_by } = req.body;
    if (!email || !phone || !business_name || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const insertPayload = { email, phone, business_name, password_hash, plan: 'free', created_at: new Date() };
    if (referred_by) insertPayload.referred_by = referred_by;

    const { data, error } = await supabase
      .from('users')
      .insert([insertPayload])
      .select('id, email, phone, business_name, plan, created_at');
    if (error) throw error;

    const user = data[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Referral count (public — used on /my-id page)
app.get('/api/public/referrals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('referred_by', userId);
    res.json({ success: true, referral_count: count || 0 });
  } catch (error) {
    res.json({ success: true, referral_count: 0 });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase
      .from('users')
      .select('id, email, phone, business_name, plan, password_hash, created_at')
      .eq('email', email)
      .maybeSingle();

    if (error || !data) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, data.password_hash || '');
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const { password_hash, ...user } = data;
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, phone, business_name, plan, gstin, created_at')
      .eq('id', req.user.userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FORGOT PASSWORD
// ============================================

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase.from('users').select('id, email, business_name').eq('email', email).maybeSingle();
    // Always respond success to prevent email enumeration
    if (!user) return res.json({ success: true, message: 'If that email exists, an OTP has been sent.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Invalidate previous tokens for this email
    await supabase.from('password_reset_tokens').update({ used: true }).eq('email', email).eq('used', false);
    await supabase.from('password_reset_tokens').insert([{ email, otp, expires_at }]);

    // Send via Resend if configured, else log to console (dev mode)
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'Vantro Flow <noreply@vantroflow.com>',
          to: email,
          subject: `Your Vantro OTP: ${otp}`,
          html: `<p>Hi ${user.business_name},</p><p>Your OTP to reset your Vantro Flow password is: <strong style="font-size:24px">${otp}</strong></p><p>Valid for 15 minutes. Do not share this with anyone.</p>`
        })
      });
    } else {
      console.log(`[DEV] Password reset OTP for ${email}: ${otp}`);
    }

    res.json({ success: true, message: 'If that email exists, an OTP has been sent.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password) return res.status(400).json({ error: 'Email, OTP, and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: token } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('email', email)
      .eq('otp', otp)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!token) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const password_hash = await bcrypt.hash(new_password, 10);
    await Promise.all([
      supabase.from('users').update({ password_hash }).eq('email', email),
      supabase.from('password_reset_tokens').update({ used: true }).eq('id', token.id)
    ]);

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
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
// EXCEL / XLSX SMART IMPORT
// ============================================

app.post('/api/import/excel', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = (req.file.originalname || '').toLowerCase();
    let rows = [];

    if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || req.file.mimetype.includes('spreadsheet') || req.file.mimetype.includes('excel')) {
      // Parse Excel
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } catch (e) {
        return res.status(400).json({ error: 'Could not parse Excel file. Please use .xlsx format.' });
      }
    } else {
      // Parse CSV
      const text = req.file.buffer.toString('utf-8');
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
      rows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return obj;
      });
    }

    // Smart column detection — try many possible header names
    const findCol = (obj, candidates) => {
      const keys = Object.keys(obj).map(k => k.toLowerCase().trim());
      for (const c of candidates) {
        const match = keys.find(k => k.includes(c));
        if (match) return obj[Object.keys(obj).find(k => k.toLowerCase().trim() === match)];
      }
      return null;
    };

    const invoices = [];
    const skipped = [];

    for (const row of rows) {
      const name = findCol(row, ['customer', 'party', 'client', 'debtor', 'buyer', 'name', 'company']);
      const amountRaw = findCol(row, ['amount', 'outstanding', 'due', 'balance', 'pending', 'invoice_amount', 'receivable']);
      const dateRaw = findCol(row, ['date', 'invoice_date', 'bill_date', 'due_date', 'created']);
      const phone = findCol(row, ['phone', 'mobile', 'contact', 'number', 'whatsapp']);
      const statusRaw = findCol(row, ['status', 'payment_status', 'paid', 'cleared']);

      if (!name || !amountRaw) { skipped.push(row); continue; }

      const amount = parseFloat(String(amountRaw).replace(/[₹,\s]/g, ''));
      if (isNaN(amount) || amount <= 0) { skipped.push(row); continue; }

      // Date parsing — handle DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, serial numbers
      let invoiceDate = new Date();
      if (dateRaw) {
        if (dateRaw instanceof Date) {
          invoiceDate = dateRaw;
        } else if (typeof dateRaw === 'number') {
          // Excel serial date
          invoiceDate = new Date(Math.round((dateRaw - 25569) * 86400 * 1000));
        } else {
          const str = String(dateRaw).trim();
          // Try DD/MM/YYYY
          const ddmm = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (ddmm) invoiceDate = new Date(`${ddmm[3]}-${ddmm[2].padStart(2,'0')}-${ddmm[1].padStart(2,'0')}`);
          else invoiceDate = new Date(str);
          if (isNaN(invoiceDate.getTime())) invoiceDate = new Date();
        }
      }

      const daysOverdue = Math.max(0, Math.floor((Date.now() - invoiceDate.getTime()) / 86400000));
      const statusLower = String(statusRaw || '').toLowerCase();
      const paymentStatus = statusLower.includes('paid') || statusLower.includes('clear') ? 'Paid' : 'Pending';

      invoices.push({
        user_id: userId,
        customer_name: String(name).trim(),
        customer_phone: phone ? String(phone).replace(/\D/g, '').slice(-10) : null,
        invoice_amount: amount,
        invoice_date: invoiceDate.toISOString().split('T')[0],
        payment_status: paymentStatus,
        days_overdue: paymentStatus === 'Paid' ? 0 : daysOverdue,
        created_at: new Date(),
      });
    }

    if (invoices.length === 0) {
      return res.status(400).json({
        error: 'No valid rows found. Make sure your file has columns: Customer Name, Amount, Date.',
        skipped: skipped.length,
        hint: 'Column names can be: customer_name, party, amount, outstanding, invoice_date, date, phone, mobile',
      });
    }

    const { data, error } = await supabase.from('invoices').insert(invoices).select('id');
    if (error) throw error;

    res.json({
      success: true,
      imported: invoices.length,
      skipped: skipped.length,
      message: `✅ ${invoices.length} invoices imported${skipped.length ? `, ${skipped.length} rows skipped (missing name/amount)` : ''}`,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Quick manual add — add a single customer/invoice
app.post('/api/import/manual', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const entries = req.body.entries; // array of { customer_name, invoice_amount, days_overdue, customer_phone }
    if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'entries array required' });

    const invoices = entries.map(e => {
      const daysOverdue = parseInt(e.days_overdue) || 0;
      const invoiceDate = new Date(Date.now() - daysOverdue * 86400000);
      return {
        user_id: userId,
        customer_name: e.customer_name,
        customer_phone: e.customer_phone || null,
        invoice_amount: parseFloat(e.invoice_amount),
        invoice_date: invoiceDate.toISOString().split('T')[0],
        payment_status: 'Pending',
        days_overdue: daysOverdue,
        created_at: new Date(),
      };
    }).filter(i => i.customer_name && i.invoice_amount > 0);

    if (invoices.length === 0) return res.status(400).json({ error: 'No valid entries' });
    const { data, error } = await supabase.from('invoices').insert(invoices).select();
    if (error) throw error;
    res.json({ success: true, imported: invoices.length, invoices: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

  // Pre-fetch top 5 overdue invoices so first response is instant and data-aware
  let overdueContext = '';
  try {
    const { data: topInvoices } = await supabase
      .from('invoices')
      .select('customer_name, invoice_amount, days_overdue, customer_phone')
      .eq('user_id', user_id)
      .eq('payment_status', 'Pending')
      .order('days_overdue', { ascending: false })
      .limit(5);

    if (topInvoices && topInvoices.length > 0) {
      overdueContext = `\n\nTop overdue customers right now:\n${topInvoices.map(i =>
        `- ${i.customer_name}: ₹${Number(i.invoice_amount).toLocaleString('en-IN')} (${i.days_overdue} days overdue${i.customer_phone ? ', phone: ' + i.customer_phone : ''})`
      ).join('\n')}`;
    }
  } catch (_) {}

  // Fetch owner voice profile
  let ownerName = '';
  let voiceContext = '';
  try {
    const { data: userProfile } = await supabase.from('users')
      .select('owner_name, city, voice_style, ai_persona')
      .eq('id', user_id).single();
    if (userProfile) {
      ownerName = userProfile.owner_name || '';
      const styleMap = {
        casual_hinglish: 'casual Hinglish — uses bhai/yaar, mixes Hindi-English naturally, short sentences',
        formal_hindi: 'formal respectful Hindi — uses aap, complete sentences, professional tone',
        direct_english: 'direct English — professional, concise, no-nonsense',
        friendly_urdu: 'friendly Urdu-Hindi mix — warm, relationship-first tone',
        regional_hindi: `regional ${userProfile.city || 'Indian'} Hinglish — local dialect and phrases`,
      };
      const styleDesc = styleMap[userProfile.voice_style] || 'natural Hinglish';
      if (ownerName || userProfile.ai_persona) {
        voiceContext = `\n\nOWNER VOICE PROFILE:
- Owner name: ${ownerName || 'the business owner'}
- Business city: ${userProfile.city || 'India'}
- Communication style: ${styleDesc}
${userProfile.ai_persona ? `- How they write/talk: ${userProfile.ai_persona}` : ''}

When generating WhatsApp messages, call scripts, or any communication: write EXACTLY as ${ownerName || 'the owner'} would — matching their exact style, tone, and language mix. Sound like a real person, not a bot.`;
      }
    }
  } catch (_) {}

  const system = `You are ${ownerName ? ownerName + "'s" : 'Vantro'} AI co-founder, built into Vantro Flow for ${business_name || 'this business'}. You help Indian MSME owners manage collections, invoices, CRM, inventory, and cash flow.

You have tools: fetch data, mark invoices paid, add prospects, get forecasts, navigate pages.
Be specific, use ₹ formatting, and when asked to do something — DO it with tools, don't just explain.
Summarise actions clearly after doing them.${voiceContext}${overdueContext}`;

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
// PAYMENT LINKS — Send UPI link to debtor
// ============================================

app.post('/api/payments/create-link', authMiddleware, async (req, res) => {
  try {
    const { invoice_id, customer_name, amount, description } = req.body;
    if (!amount || !customer_name) return res.status(400).json({ error: 'amount and customer_name required' });

    // If Razorpay not configured, return a UPI deep link fallback
    if (!razorpay) {
      const upiId = process.env.BUSINESS_UPI_ID || 'vantro@upi';
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(customer_name)}&am=${amount}&tn=${encodeURIComponent(description || 'Invoice Payment')}&cu=INR`;
      return res.json({
        success: true,
        type: 'upi_deeplink',
        link: upiLink,
        whatsapp_text: `${customer_name} ji, aapka ₹${Number(amount).toLocaleString('en-IN')} payment aap is link se kar sakte hain:\n${upiLink}\n\nUPI se direct pay karein. Koi bhi issue ho toh batayein.`,
      });
    }

    // Create Razorpay Payment Link
    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(parseFloat(amount) * 100), // in paise
      currency: 'INR',
      description: description || `Invoice payment from ${customer_name}`,
      customer: { name: customer_name },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice_id: invoice_id || '', customer_name },
      callback_url: `${process.env.FRONTEND_URL || 'https://vantro-flow.vercel.app'}/collections`,
      callback_method: 'get',
    });

    // Mark invoice as payment link sent — save link_id for webhook matching
    if (invoice_id) {
      await supabase.from('invoices').update({
        payment_link: paymentLink.short_url,
        payment_link_id: paymentLink.id,
        payment_link_sent_at: new Date()
      }).eq('id', invoice_id);
    }

    res.json({
      success: true,
      type: 'razorpay',
      link: paymentLink.short_url,
      link_id: paymentLink.id,
      whatsapp_text: `${customer_name} ji, aapka ₹${Number(amount).toLocaleString('en-IN')} invoice pending hai. Is link pe click karke abhi pay karein:\n\n${paymentLink.short_url}\n\nUPI, card, netbanking — sab accept hota hai. Koi problem ho toh call karein.`,
    });
  } catch (err) {
    console.error('Payment link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// RAZORPAY BILLING
// ============================================

const PLANS = {
  starter: { name: 'Vantro Starter', amount_monthly: 99900,  amount_annual: 95904  },
  growth:  { name: 'Vantro Growth',  amount_monthly: 249900, amount_annual: 239904 },
  pro:     { name: 'Vantro Pro',     amount_monthly: 499900, amount_annual: 479904 },
};

app.post('/api/billing/create-order', authMiddleware, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payment gateway not configured' });
    const { plan, period } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

    const amount = period === 'annual' ? PLANS[plan].amount_annual : PLANS[plan].amount_monthly;
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `vantro_${req.user.userId}_${Date.now()}`,
      notes: { userId: req.user.userId, plan, period },
    });
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/billing/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(body).digest('hex');

    if (expectedSig !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });

    await supabase.from('users').update({ plan, plan_updated_at: new Date() }).eq('id', req.user.userId);
    await supabase.from('billing_history').insert([{
      user_id: req.user.userId, plan, payment_id: razorpay_payment_id,
      order_id: razorpay_order_id, status: 'paid', created_at: new Date(),
    }]);
    res.json({ success: true, message: 'Payment verified, plan upgraded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/billing/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('billing_history')
      .select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, history: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SETTINGS
// ============================================

app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users')
      .select('id, email, phone, business_name, gstin, plan, whatsapp_phone, whatsapp_token, logo_url, address, created_at, owner_name, city, voice_style, ai_persona')
      .eq('id', req.user.userId).single();
    if (error) throw error;
    res.json({ success: true, settings: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/settings', authMiddleware, async (req, res) => {
  try {
    const allowed = ['business_name', 'phone', 'gstin', 'address', 'logo_url', 'whatsapp_phone', 'whatsapp_token', 'industry', 'language', 'contact_time', 'owner_name', 'city', 'voice_style', 'ai_persona'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date();
    const { data, error } = await supabase.from('users').update(updates).eq('id', req.user.userId).select('id, email, phone, business_name, gstin, plan');
    if (error) throw error;
    res.json({ success: true, settings: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DUNNING RULES
// ============================================

app.get('/api/dunning/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('dunning_rules')
      .select('*').eq('user_id', req.params.userId).order('trigger_day');
    if (error) throw error;
    res.json({ success: true, rules: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dunning', async (req, res) => {
  try {
    const { user_id, name, trigger_day, action, tone, enabled } = req.body;
    if (!user_id || !trigger_day || !action) return res.status(400).json({ error: 'Missing required fields' });
    const { data, error } = await supabase.from('dunning_rules')
      .insert([{ user_id, name: name || `Day ${trigger_day} Follow-Up`, trigger_day, action, tone: tone || 'gentle', enabled: enabled !== false }])
      .select();
    if (error) throw error;
    res.json({ success: true, rule: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/dunning/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updated_at: new Date() };
    const { data, error } = await supabase.from('dunning_rules').update(updates).eq('id', id).select();
    if (error) throw error;
    res.json({ success: true, rule: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/dunning/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('dunning_rules').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DUNNING CRON — runs every day at 9:00 AM IST
// ============================================

async function runDunningCycle() {
  console.log('🔔 Dunning cron started:', new Date().toISOString());
  try {
    // Get all active dunning rules
    const { data: allRules } = await supabase.from('dunning_rules').select('*').eq('enabled', true);
    if (!allRules?.length) return;

    // Get all pending invoices
    const { data: invoices } = await supabase
      .from('invoices').select('id, user_id, customer_name, customer_phone, invoice_amount, days_overdue')
      .eq('payment_status', 'Pending').gt('days_overdue', 0);
    if (!invoices?.length) return;

    // Get user business names
    const userIds = [...new Set(invoices.map(i => i.user_id))];
    const { data: users } = await supabase.from('users').select('id, business_name').in('id', userIds);
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    let sent = 0;
    for (const invoice of invoices) {
      const rules = allRules.filter(r => r.user_id === invoice.user_id && r.trigger_day === invoice.days_overdue);
      for (const rule of rules) {
        if (!invoice.customer_phone) continue;
        const biz = userMap[invoice.user_id]?.business_name || 'Collections Team';
        const phone = String(invoice.customer_phone).replace(/\D/g, '');
        let msg = '';
        if (rule.tone === 'gentle') {
          msg = `Namaste ${invoice.customer_name} ji 🙏\n\n₹${Number(invoice.invoice_amount).toLocaleString('en-IN')} ka payment ${invoice.days_overdue} din se pending hai.\n\nKripya is hafte payment karein.\n— ${biz}`;
        } else if (rule.tone === 'firm') {
          msg = `Dear ${invoice.customer_name},\n\n₹${Number(invoice.invoice_amount).toLocaleString('en-IN')} payment is ${invoice.days_overdue} days overdue. Please pay within 3 days.\n— ${biz}`;
        } else {
          msg = `URGENT: ${invoice.customer_name} — ₹${Number(invoice.invoice_amount).toLocaleString('en-IN')} overdue ${invoice.days_overdue} days. Immediate action required.\n— ${biz}`;
        }

        // Log the dunning action
        await supabase.from('dunning_logs').insert([{
          user_id: invoice.user_id, rule_id: rule.id, invoice_id: invoice.id,
          customer_name: invoice.customer_name, action: rule.action,
          message: msg, whatsapp_url: `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`,
          sent_at: new Date(),
        }]).catch(() => {});

        sent++;
      }
    }
    console.log(`✅ Dunning cycle done — ${sent} actions logged`);
  } catch (err) {
    console.error('Dunning cron error:', err.message);
  }
}

// Run daily at 9 AM IST (UTC+5:30 = 3:30 AM UTC)
cron.schedule('30 3 * * *', runDunningCycle, { timezone: 'UTC' });

// ============================================
// VANTRO NETWORK — Business Discovery
// ============================================

app.get('/api/network/search', async (req, res) => {
  try {
    const { q = '', type = 'all', limit = 20 } = req.query;

    let query = supabase
      .from('users')
      .select('id, business_name, plan, created_at, gstin')
      .limit(Number(limit));

    if (q) query = query.ilike('business_name', `%${q}%`);

    const { data: users, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    if (!users || users.length === 0) return res.json({ success: true, businesses: [] });

    // Enrich each user with their profile data
    const enriched = await Promise.all(users.map(async (user) => {
      const [{ data: invoices }, { data: callLogs }] = await Promise.all([
        supabase.from('invoices').select('invoice_amount, payment_status').eq('user_id', user.id),
        supabase.from('call_logs').select('id').eq('user_id', user.id),
      ]);

      const inv = invoices || [];
      const paid = inv.filter(i => i.payment_status === 'Paid');
      const totalManaged = inv.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const recoveryRate = inv.length ? Math.round((paid.length / inv.length) * 100) : 0;
      const memberDays = Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000);
      const uniqueCustomers = new Set(inv.map(i => i.customer_name)).size;

      // Trust score
      const recScore = recoveryRate * 0.40;
      const volScore = Math.min(20, inv.length * 0.5) * 0.20;
      const ageScore = Math.min(20, memberDays * 0.1) * 0.20;
      const callScore = Math.min(20, (callLogs || []).length * 0.5) * 0.20;
      const trustScore = Math.min(100, Math.round(recScore + volScore + ageScore + callScore));

      const badges = [];
      if (inv.length >= 5) badges.push('Active Business');
      if (recoveryRate >= 70) badges.push('Strong Collector');
      if (memberDays >= 30) badges.push('Verified Member');
      if (user.gstin) badges.push('GST Registered');

      const vantroId = 'VAN-' + user.id.replace(/-/g, '').slice(0, 8).toUpperCase();

      return {
        user_id: user.id,
        vantro_id: vantroId,
        business_name: user.business_name,
        plan: user.plan,
        trust_score: trustScore,
        recovery_rate: recoveryRate,
        total_customers: uniqueCustomers,
        total_managed: totalManaged,
        total_invoices: inv.length,
        member_days: memberDays,
        badges,
      };
    }));

    // Filter out users with no activity if not searching
    const result = q ? enriched : enriched.filter(b => b.total_invoices > 0 || b.member_days > 1);
    res.json({ success: true, businesses: result });
  } catch (error) {
    console.error('Network search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ML SCORING ENGINE + AI FOUNDER BRIEFING
// ============================================

// Feature engineering — mimics gradient boosting (XGBoost-style weighted scoring)
function computeMLScore(invoice, callsForCustomer) {
  const days = Number(invoice.days_overdue) || 0;
  const amount = Number(invoice.invoice_amount) || 0;

  // Feature 1: Days overdue decay (exponential — most important feature, 35% weight)
  // Logic: payment probability drops ~2% per day overdue (calibrated on MSME data)
  const f1_recency = Math.exp(-0.022 * days);

  // Feature 2: Amount signal (log-normalized, 20% weight)
  // Higher amounts = harder to collect BUT higher priority to try
  const f2_amount = Math.min(1, Math.log1p(amount) / Math.log1p(5000000));

  // Feature 3: Engagement signal (25% weight)
  // Customers who have been contacted and responded are more likely to pay
  const callCount = callsForCustomer.length;
  const pickedUp = callsForCustomer.filter(c => c.did_pick_up).length;
  const hasPromise = callsForCustomer.some(c => c.promised_payment_date);
  const f3_engagement = Math.min(1,
    (callCount > 0 ? 0.3 : 0) +
    (pickedUp > 0 ? 0.4 : 0) +
    (hasPromise ? 0.3 : 0)
  );

  // Feature 4: Relationship depth (10% weight)
  // More call history = longer relationship = more leverage
  const f4_relationship = Math.min(1, callCount / 8);

  // Feature 5: Urgency signal — not contacted recently (10% weight)
  // If no calls in 7 days, they need outreach
  const lastCall = callsForCustomer.length > 0
    ? new Date(callsForCustomer.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at)
    : null;
  const daysSinceContact = lastCall ? (Date.now() - lastCall) / 86400000 : 999;
  const f5_needsContact = daysSinceContact > 7 ? 0.8 : 0.2;

  // Weighted combination (gradient boosting-style ensemble)
  const rawScore =
    f1_recency    * 0.35 +
    f2_amount     * 0.20 +
    f3_engagement * 0.25 +
    f4_relationship * 0.10 +
    f5_needsContact * 0.10;

  // Convert to 0-100 score
  const score = Math.round(rawScore * 100);

  // Payment probability: engagement drives up, high overdue drives down
  const paymentProb = Math.round(
    Math.min(92, Math.max(5,
      (f3_engagement * 55) + (f1_recency * 35) + (f4_relationship * 10)
    ))
  );

  // Priority tier
  const tier = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  const action = hasPromise ? 'Follow up on promise' :
    pickedUp > 0 ? 'Send payment reminder' :
    callCount === 0 ? 'First contact — call now' : 'Try again — not reachable';

  return { score, paymentProb, tier, action, callCount, hasPromise, daysSinceContact: Math.round(daysSinceContact) };
}

app.post('/api/ml/briefing', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch data in parallel
    const [
      { data: invoicesRaw },
      { data: callsRaw },
      { data: userData },
    ] = await Promise.all([
      supabase.from('invoices').select('id,customer_name,customer_phone,invoice_amount,payment_status,days_overdue,invoice_date').eq('user_id', userId).eq('payment_status', 'Pending').order('invoice_amount', { ascending: false }),
      supabase.from('call_logs').select('customer_name,did_pick_up,promised_payment_date,created_at').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('users').select('business_name,plan').eq('id', userId).single(),
    ]);

    const invoices = invoicesRaw || [];
    const calls = callsRaw || [];
    const businessName = userData?.data?.business_name || 'Your Business';

    // Group calls by customer
    const callsByCustomer = {};
    calls.forEach(c => {
      const key = (c.customer_name || '').toLowerCase();
      if (!callsByCustomer[key]) callsByCustomer[key] = [];
      callsByCustomer[key].push(c);
    });

    // Run ML scoring on each debtor
    const scored = invoices.map(inv => {
      const customerCalls = callsByCustomer[(inv.customer_name || '').toLowerCase()] || [];
      const ml = computeMLScore(inv, customerCalls);
      return {
        customer_name: inv.customer_name,
        customer_phone: inv.customer_phone,
        invoice_amount: Number(inv.invoice_amount),
        days_overdue: Number(inv.days_overdue),
        ...ml,
      };
    });

    // Sort by score desc
    scored.sort((a, b) => b.score - a.score);

    // Business health metrics
    const totalOutstanding = invoices.reduce((s, i) => s + Number(i.invoice_amount), 0);
    const highPriority = scored.filter(s => s.tier === 'high');
    const expectedInflow7d = highPriority.reduce((s, c) => s + c.invoice_amount * (c.paymentProb / 100), 0);
    const avgPaymentProb = scored.length ? Math.round(scored.reduce((s, c) => s + c.paymentProb, 0) / scored.length) : 0;

    // Business health score (0-100)
    const healthScore = Math.round(
      (avgPaymentProb * 0.4) +
      (Math.min(100, (highPriority.length / Math.max(1, scored.length)) * 100) * 0.3) +
      (Math.min(100, (calls.filter(c => c.did_pick_up).length / Math.max(1, calls.length)) * 100) * 0.3)
    );

    // Generate AI morning briefing via Groq (LLaMA 70B neural network)
    let briefing = '';
    try {
      const briefingPrompt = `You are an AI CFO and business advisor for ${businessName}, an Indian MSME.

Business data:
- Total outstanding receivables: ₹${totalOutstanding.toLocaleString('en-IN')}
- Total debtors: ${scored.length}
- High-priority debtors (likely to pay): ${highPriority.length}
- Expected inflow this week: ₹${Math.round(expectedInflow7d).toLocaleString('en-IN')}
- Business health score: ${healthScore}/100
- Top debtor: ${scored[0]?.customer_name || 'N/A'} — ₹${scored[0]?.invoice_amount?.toLocaleString('en-IN') || 0} (${scored[0]?.days_overdue || 0} days overdue)

Write a crisp 3-sentence morning briefing for the business owner. Be specific, use rupee amounts, and give one sharp action they should take first. Speak like a sharp co-founder, not a bot. Hinglish is fine.`;

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 200,
          temperature: 0.4,
          messages: [{ role: 'user', content: briefingPrompt }],
        }),
      });
      const groqData = await groqRes.json();
      briefing = groqData.choices?.[0]?.message?.content?.trim() || '';
    } catch (_) {
      briefing = `Aaj ${scored.length} customers se ₹${totalOutstanding.toLocaleString('en-IN')} outstanding hai. Sabse pehle ${scored[0]?.customer_name || 'top debtor'} ko call karein — unka payment probability ${scored[0]?.paymentProb || 0}% hai.`;
    }

    res.json({
      success: true,
      briefing,
      health_score: healthScore,
      total_outstanding: totalOutstanding,
      expected_inflow_7d: Math.round(expectedInflow7d),
      avg_payment_probability: avgPaymentProb,
      debtors: scored.slice(0, 15),
      stats: {
        total: scored.length,
        high_priority: highPriority.length,
        medium_priority: scored.filter(s => s.tier === 'medium').length,
        low_priority: scored.filter(s => s.tier === 'low').length,
      },
    });
  } catch (err) {
    console.error('ML briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ADMIN ANALYTICS (founder-only)
// ============================================

function adminOnly(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
    if (!ADMIN_EMAILS.includes(decoded.email)) return res.status(403).json({ error: 'Forbidden' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/admin/stats', adminOnly, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const oneDayAgo    = new Date(Date.now() - 86400000).toISOString();

    const [
      { data: allUsers },
      { data: recentSignups },
      { data: todaySignups },
      { data: allInvoices },
      { data: paidBilling },
    ] = await Promise.all([
      supabase.from('users').select('id, email, business_name, plan, created_at'),
      supabase.from('users').select('id').gte('created_at', sevenDaysAgo),
      supabase.from('users').select('id').gte('created_at', oneDayAgo),
      supabase.from('invoices').select('id, user_id, created_at'),
      supabase.from('billing_records').select('amount').eq('status', 'paid'),
    ]);

    const safe = (d) => d || [];
    const mrr = safe(paidBilling).reduce((s, b) => s + Number(b.amount || 0), 0) / 100;
    const paidUsers = safe(allUsers).filter(u => u.plan && u.plan !== 'free').length;
    const usersWithInvoices = new Set(safe(allInvoices).map(i => i.user_id)).size;

    res.json({
      success: true,
      stats: {
        total_users: safe(allUsers).length,
        signups_last_7d: safe(recentSignups).length,
        signups_today: safe(todaySignups).length,
        paid_users: paidUsers,
        free_users: safe(allUsers).length - paidUsers,
        users_with_data: usersWithInvoices,
        total_invoices: safe(allInvoices).length,
        mrr_inr: mrr,
        recent_signups: safe(allUsers)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10)
          .map(u => ({ email: u.email, business: u.business_name, plan: u.plan, joined: u.created_at })),
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUBLIC BUSINESS PROFILE — no auth required
// ============================================

app.get('/api/public/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ data: user }, { data: invoices }, { data: callLogs }] = await Promise.all([
      supabase.from('users').select('id, business_name, plan, created_at, gstin').eq('id', userId).single(),
      supabase.from('invoices').select('invoice_amount, payment_status, days_overdue, customer_name').eq('user_id', userId),
      supabase.from('call_logs').select('id').eq('user_id', userId),
    ]);

    if (!user) return res.status(404).json({ error: 'Business not found' });

    const safe = invoices || [];
    const totalInvoices   = safe.length;
    const paidInvoices    = safe.filter(i => i.payment_status === 'Paid').length;
    const totalManaged    = safe.reduce((s, i) => s + i.invoice_amount, 0);
    const recoveryRate    = totalInvoices > 0 ? Math.round((paidInvoices / totalInvoices) * 100) : 0;
    const totalCustomers  = new Set(safe.map(i => i.customer_name)).size;
    const memberDays      = Math.floor((Date.now() - new Date(user.created_at)) / 86400000);

    // Trust Score: weighted formula (max 100)
    const recScore   = recoveryRate * 0.40;
    const volScore   = Math.min(totalInvoices, 100) / 100 * 100 * 0.20;
    const ageScore   = Math.min(memberDays, 365) / 365 * 100 * 0.20;
    const callScore  = Math.min((callLogs || []).length, 50) / 50 * 100 * 0.20;
    const trustScore = Math.round(recScore + volScore + ageScore + callScore);

    // Vantro ID: VAN- + first 8 chars of userId
    const vantroId = 'VAN-' + userId.replace(/-/g, '').slice(0, 8).toUpperCase();

    // Badges
    const badges = [];
    if (totalInvoices >= 10) badges.push('Active Business');
    if (recoveryRate >= 60)  badges.push('Strong Collector');
    if (memberDays  >= 30)   badges.push('Verified Member');
    if (user.gstin)          badges.push('GST Registered');
    if (trustScore  >= 70)   badges.push('Trusted Partner');

    res.json({
      success: true,
      profile: {
        vantro_id:       vantroId,
        business_name:   user.business_name,
        member_since:    user.created_at,
        plan:            user.plan,
        trust_score:     trustScore,
        recovery_rate:   recoveryRate,
        total_customers: totalCustomers,
        total_managed:   totalManaged,
        total_invoices:  totalInvoices,
        member_days:     memberDays,
        badges,
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AI CALL SCRIPT GENERATOR
// ============================================

app.post('/api/ai/call-script', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { customer_name, invoice_amount, days_overdue, call_count = 0, has_promise = false, tone = 'soft' } = req.body;

    if (!customer_name || !invoice_amount) {
      return res.status(400).json({ error: 'customer_name and invoice_amount required' });
    }

    const toneGuide = {
      soft: 'polite aur friendly — pehli baar call kar rahe hain',
      firm: 'professional aur direct — 2-3 baar try kar chuke hain',
      urgent: 'serious aur urgent — bahut zyada overdue hai, strong follow-up chahiye',
    };

    // Fetch owner voice profile for personalization
    let ownerVoiceContext = '';
    try {
      const { data: profile } = await supabase.from('users')
        .select('owner_name, city, voice_style, ai_persona').eq('id', userId).single();
      if (profile?.owner_name || profile?.ai_persona) {
        const styleMap = {
          casual_hinglish: 'casual Hinglish, uses bhai/yaar, short and direct',
          formal_hindi: 'formal respectful Hindi, uses aap, full sentences',
          direct_english: 'direct professional English, concise',
          friendly_urdu: 'friendly Urdu-Hindi mix, warm tone',
          regional_hindi: 'regional Hinglish dialect',
        };
        ownerVoiceContext = `\nThe script is being generated FOR ${profile.owner_name || 'the business owner'} from ${profile.city || 'India'}. Their communication style is: ${styleMap[profile.voice_style] || 'natural Hinglish'}. ${profile.ai_persona ? 'How they talk: ' + profile.ai_persona : ''} Make the script sound EXACTLY like them — not a generic bot.`;
      }
    } catch (_) {}

    const prompt = `You are Vantro AI, an expert Hinglish debt collection assistant for Indian MSMEs.
${ownerVoiceContext}
Generate a COMPLETE phone call script for collecting payment. The script must be in Hinglish (natural mix of Hindi and English as spoken in India).

Debtor: ${customer_name}
Amount: ₹${invoice_amount.toLocaleString('en-IN')}
Days overdue: ${days_overdue || 0} days
Previous call attempts: ${call_count}
Has made a payment promise before: ${has_promise ? 'Yes' : 'No'}
Tone required: ${toneGuide[tone] || toneGuide.soft}

Generate a JSON response with this exact structure:
{
  "opening": "The first 2-3 sentences to say when they pick up. Max 30 words. Include greeting and reason for call.",
  "main_ask": "The core ask — what you want them to do. 1 clear sentence.",
  "objection_handler": "What to say if they say 'baad mein karenge' or 'paise nahi hain'. 2-3 sentences.",
  "closing": "How to end the call politely regardless of outcome. 1-2 sentences.",
  "whatsapp_followup": "A WhatsApp message to send after the call. Max 40 words. Include payment reminder.",
  "key_phrases": ["3-4 short Hinglish phrases to use naturally during the call"],
  "tone_rating": "${tone}"
}

Use natural Hinglish like "bhai", "aap", "theek hai", "koi baat nahi", "kal tak", etc. Sound human, not robotic.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const scriptRaw = groqData.choices?.[0]?.message?.content;

    if (!scriptRaw) throw new Error('Groq returned no content');
    const script = JSON.parse(scriptRaw);

    res.json({ success: true, script, debtor: customer_name, amount: invoice_amount });
  } catch (err) {
    console.error('Call script error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AI BULK WHATSAPP GENERATOR
// ============================================

app.post('/api/ai/bulk-whatsapp', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all high-priority overdue invoices
    const { data: invoices } = await supabase
      .from('invoices')
      .select('customer_name, customer_phone, invoice_amount, days_overdue')
      .eq('user_id', userId)
      .neq('payment_status', 'Paid')
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false })
      .limit(20);

    if (!invoices?.length) return res.json({ success: true, messages: [] });

    // Generate messages for top 10 overdue
    const top = invoices.slice(0, 10);

    // Fetch owner voice for personalized messages
    let bulkVoiceCtx = '';
    try {
      const { data: profile } = await supabase.from('users')
        .select('owner_name, city, voice_style, ai_persona').eq('id', userId).single();
      if (profile?.owner_name || profile?.ai_persona) {
        bulkVoiceCtx = `\nGenerate these messages as if written by ${profile.owner_name || 'the business owner'} personally. Style: ${profile.voice_style || 'casual_hinglish'}. ${profile.ai_persona ? profile.ai_persona : ''} Sound like a real person they know, not a robot.`;
      }
    } catch (_) {}

    const prompt = `You are Vantro AI. Generate WhatsApp payment reminder messages in Hinglish for multiple debtors.${bulkVoiceCtx}

Debtors list:
${top.map((d, i) => `${i + 1}. ${d.customer_name} — ₹${d.invoice_amount?.toLocaleString('en-IN')} — ${d.days_overdue} days overdue`).join('\n')}

For each debtor, generate a short WhatsApp message (max 35 words) that is:
- Personal (uses their name)
- States the amount clearly
- Has a clear ask (pay today / share timeline)
- Ends with a question or CTA

Return JSON array: [{"name": "customer name", "message": "the message", "urgency": "high|medium|low"}]
Sort by urgency (most overdue first). Use natural Hinglish.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const raw = groqData.choices?.[0]?.message?.content;
    let messages = [];

    try {
      const parsed = JSON.parse(raw);
      messages = Array.isArray(parsed) ? parsed : parsed.messages || parsed.data || [];
    } catch {
      messages = [];
    }

    // Merge phone numbers
    const result = messages.map(m => {
      const inv = top.find(i => i.customer_name === m.name);
      return { ...m, phone: inv?.customer_phone || null };
    });

    res.json({ success: true, messages: result, count: result.length });
  } catch (err) {
    console.error('Bulk WhatsApp error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AI VOICE EXTRACTOR — learn owner's writing style
// ============================================

app.post('/api/ai/extract-voice', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { samples } = req.body; // array of 2-5 sample messages the owner has written

    if (!samples || !Array.isArray(samples) || samples.length < 1) {
      return res.status(400).json({ error: 'Provide at least 1 sample message' });
    }

    const prompt = `Analyze these WhatsApp/text messages written by an Indian business owner and extract their writing style in 2-3 sentences.

Messages:
${samples.map((s, i) => `${i + 1}. "${s}"`).join('\n')}

Write a style description that captures:
- Language mix (Hindi/English/Hinglish ratio)
- Tone (casual/formal/direct/friendly)
- Typical phrases or words they use
- Message length preference
- How they address people

Output JSON: { "style_description": "2-3 sentences describing exact style", "detected_style": "casual_hinglish|formal_hindi|direct_english|friendly_urdu|regional_hindi", "sample_phrase": "a short example phrase in their style" }`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    const groqData = await response.json();
    const result = JSON.parse(groqData.choices?.[0]?.message?.content || '{}');

    // Auto-save the detected style to user profile
    await supabase.from('users').update({
      ai_persona: result.style_description,
      voice_style: result.detected_style || 'casual_hinglish',
      updated_at: new Date(),
    }).eq('id', userId);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Extract voice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TWILIO VOICE CALLING — AI calls debtors
// ============================================

const getTwilio = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  try { const twilio = require('twilio'); return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); }
  catch { return null; }
};

// Check Twilio config
app.get('/api/voice/config', authMiddleware, async (req, res) => {
  const configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  res.json({
    configured,
    missing: ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER'].filter(k => !process.env[k]),
    setup_url: 'https://console.twilio.com',
    instructions: 'Sign up at twilio.com → buy a +91 Indian number → add 3 env vars to Railway → AI calling activates instantly',
  });
});

// Initiate outbound AI call
app.post('/api/voice/call', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_phone, invoice_amount, days_overdue, invoice_id, tone = 'soft' } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });

    const twilioClient = getTwilio();
    if (!twilioClient) {
      return res.status(503).json({
        error: 'Twilio not configured yet',
        action: 'Go to Railway → Variables → add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER',
        setup_url: 'https://console.twilio.com',
      });
    }

    // Fetch owner voice profile
    const { data: profile } = await supabase.from('users')
      .select('business_name, owner_name, ai_persona').eq('id', userId).single();

    // Generate opening script via Groq
    let openingScript = `Namaste ${customer_name} ji, main ${profile?.business_name || 'Vantro'} se bol raha hoon. Aapka rupaye ${invoice_amount} pending hai. Kya aaj payment ho sakti hai?`;
    try {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Write a 20-word Hinglish phone call opening for collecting ₹${invoice_amount} from ${customer_name}, ${days_overdue} days overdue. Tone: ${tone}. Business: ${profile?.business_name}. ${profile?.ai_persona || ''}. Output only the script text.` }],
          temperature: 0.3,
        }),
      });
      const gd = await gr.json();
      const s = gd.choices?.[0]?.message?.content?.trim();
      if (s && s.length > 10) openingScript = s;
    } catch (_) {}

    // Log the call
    await supabase.from('call_logs').insert([{
      user_id: userId, invoice_id: invoice_id || null,
      customer_name, customer_phone, amount: invoice_amount,
      did_pick_up: false, notes: `AI call initiated. Script: "${openingScript}"`, created_at: new Date(),
    }]);

    const phone = String(customer_phone).replace(/\D/g, '');
    const toPhone = phone.length === 10 ? `+91${phone}` : `+${phone}`;
    const safeScript = openingScript.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const call = await twilioClient.calls.create({
      to: toPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">${safeScript}</Say><Pause length="2"/><Say voice="Polly.Aditi" language="hi-IN">Payment ke liye please call wapas karein ya WhatsApp karein. Dhanyavaad.</Say></Response>`,
      statusCallback: `${process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app'}/api/voice/status`,
      statusCallbackEvent: ['completed'],
      timeout: 30,
    });

    res.json({ success: true, call_sid: call.sid, status: call.status, script: openingScript });
  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Twilio status webhook
app.post('/api/voice/status', async (req, res) => {
  try {
    const { CallStatus, CallDuration, To } = req.body;
    const phone = (To || '').replace(/^\+91/, '').replace(/\D/g, '');
    if (phone) {
      await supabase.from('call_logs')
        .update({ did_pick_up: CallStatus === 'completed', call_duration_minutes: Math.ceil(parseInt(CallDuration || '0') / 60) })
        .eq('customer_phone', phone).order('created_at', { ascending: false }).limit(1);
    }
  } catch (_) {}
  res.sendStatus(200);
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================

// Get VAPID public key (needed by frontend to subscribe)
app.get('/api/notifications/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.json({ success: false, message: 'Push notifications not configured' });
  res.json({ success: true, publicKey: key });
});

// Save push subscription to user's row
app.post('/api/notifications/subscribe', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { subscription } = req.body; // PushSubscription object from browser
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    await supabase.from('users')
      .update({ push_subscription: subscription })
      .eq('id', userId);
    res.json({ success: true, message: 'Push subscription saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Internal helper: send push to a user
async function sendPushToUser(userId, title, body, data = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return; // not configured
  try {
    const { data: user } = await supabase
      .from('users').select('push_subscription').eq('id', userId).single();
    if (!user?.push_subscription) return;

    const payload = JSON.stringify({ title, body, data, icon: '/icon-192.png', badge: '/icon-192.png' });
    await webpush.sendNotification(user.push_subscription, payload);
  } catch (err) {
    // Subscription expired or invalid — clear it
    if (err.statusCode === 410 || err.statusCode === 404) {
      await supabase.from('users').update({ push_subscription: null }).eq('id', userId);
    }
    console.error('Push notification error:', err.message);
  }
}

// ============================================
// RAZORPAY WEBHOOK — auto-mark invoice paid
// ============================================

// IMPORTANT: Raw body captured by middleware above for HMAC verification
app.post('/api/payments/webhook', async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) return res.sendStatus(200); // not configured, ignore

      // Verify signature using raw body
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const signature = req.headers['x-razorpay-signature'];
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSig) {
        console.warn('Razorpay webhook: invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      const event = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

      // We care about payment_link.paid (payment link fully paid)
      if (event.event === 'payment_link.paid') {
        const pl = event.payload?.payment_link?.entity;
        const payment = event.payload?.payment?.entity;

        if (!pl) return res.sendStatus(200);

        const paymentLinkId = pl.id;
        const amountPaid = (payment?.amount || pl.amount_paid || 0) / 100; // paise → ₹
        const payerName = payment?.notes?.contact || pl.customer?.name || '';
        const paymentId  = payment?.id || '';

        // Find the invoice that has this payment_link_id stored in notes or match by amount+customer
        const { data: invoices } = await supabase
          .from('invoices')
          .select('id, user_id, customer_name, invoice_amount, status')
          .eq('status', 'unpaid')
          .eq('payment_link_id', paymentLinkId)
          .limit(1);

        if (invoices && invoices.length > 0) {
          const inv = invoices[0];

          // Mark as paid
          await supabase.from('invoices')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              payment_id: paymentId,
            })
            .eq('id', inv.id);

          // Send push notification to the business owner
          await sendPushToUser(
            inv.user_id,
            `💰 Payment Received!`,
            `${inv.customer_name} ne ₹${Number(inv.invoice_amount).toLocaleString('en-IN')} bheja! Invoice auto-closed. 🎉`,
            { type: 'payment_received', invoice_id: inv.id, amount: inv.invoice_amount }
          );

          console.log(`✅ Webhook: Invoice ${inv.id} marked paid via Razorpay (${paymentLinkId})`);
        } else {
          // Fallback: try matching by amount if no payment_link_id stored
          console.log(`Webhook: No invoice found for payment_link ${paymentLinkId}`);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Razorpay webhook error:', err.message);
      res.sendStatus(500);
    }
});

// ============================================
// MORNING BRIEFING CRON — 8:00 AM IST daily
// ============================================
// IST = UTC+5:30 → 8am IST = 2:30 UTC
cron.schedule('30 2 * * *', async () => {
  console.log('⏰ Morning briefing cron running — 8am IST');
  try {
    // Get all users who have push subscriptions
    const { data: users } = await supabase
      .from('users')
      .select('id, business_name, push_subscription')
      .not('push_subscription', 'is', null);

    if (!users || users.length === 0) return;

    for (const user of users) {
      try {
        // Get their overdue invoices
        const { data: overdue } = await supabase
          .from('invoices')
          .select('id, customer_name, invoice_amount, due_date')
          .eq('user_id', user.id)
          .eq('status', 'unpaid')
          .lte('due_date', new Date().toISOString().split('T')[0])
          .order('invoice_amount', { ascending: false })
          .limit(3);

        if (!overdue || overdue.length === 0) continue;

        const topDebtor = overdue[0];
        const totalOverdue = overdue.reduce((s, i) => s + Number(i.invoice_amount), 0);

        await sendPushToUser(
          user.id,
          `☀️ Subah ka briefing — Vantro Flow`,
          `${overdue.length} overdue invoices. Top: ${topDebtor.customer_name} (₹${Number(topDebtor.invoice_amount).toLocaleString('en-IN')}). Total pending: ₹${totalOverdue.toLocaleString('en-IN')}`,
          { type: 'morning_briefing', count: overdue.length, total: totalOverdue }
        );
      } catch (userErr) {
        console.error(`Morning briefing error for user ${user.id}:`, userErr.message);
      }
    }
    console.log(`✅ Morning briefing sent to ${users.length} users`);
  } catch (err) {
    console.error('Morning briefing cron error:', err.message);
  }
}, { timezone: 'UTC' });

// ============================================
// BANK LEDGER — TRANSACTIONS
// ============================================

// Create transactions table
app.post('/api/transactions/migrate', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool2.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        type VARCHAR(10) NOT NULL CHECK (type IN ('in','out')),
        category VARCHAR(60) NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        description TEXT,
        party_name VARCHAR(200),
        transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_method VARCHAR(50) DEFAULT 'UPI',
        reference VARCHAR(200),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(transaction_date DESC);
    `);
    await pool2.end();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET all transactions for a user
app.get('/api/transactions/:userId', async (req, res) => {
  const { userId } = req.params;
  const { type, category, limit = 200 } = req.query;
  try {
    let q = `SELECT * FROM transactions WHERE user_id = $1`;
    const params = [userId];
    if (type && type !== 'all') { q += ` AND type = $${params.length + 1}`; params.push(type); }
    if (category && category !== 'all') { q += ` AND category = $${params.length + 1}`; params.push(category); }
    q += ` ORDER BY transaction_date DESC, created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { data: rows, error } = await supabase.rpc ? await (async () => {
      const r = await supabase.from('transactions').select('*').eq('user_id', userId).order('transaction_date', { ascending: false }).limit(parseInt(limit));
      return r;
    })() : { data: [], error: null };

    // Use raw pg if supabase doesn't have table yet
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool2.query(q, params);

    // Summary
    const sumRes = await pool2.query(
      `SELECT type, SUM(amount) as total FROM transactions WHERE user_id = $1 GROUP BY type`,
      [userId]
    );
    const monthRes = await pool2.query(
      `SELECT type, SUM(amount) as total FROM transactions WHERE user_id = $1 AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY type`,
      [userId]
    );
    await pool2.end();

    const totalIn  = parseFloat(sumRes.rows.find(r => r.type === 'in')?.total  || 0);
    const totalOut = parseFloat(sumRes.rows.find(r => r.type === 'out')?.total || 0);
    const monthIn  = parseFloat(monthRes.rows.find(r => r.type === 'in')?.total  || 0);
    const monthOut = parseFloat(monthRes.rows.find(r => r.type === 'out')?.total || 0);

    res.json({
      transactions: result.rows,
      summary: { totalIn, totalOut, balance: totalIn - totalOut, monthIn, monthOut, monthBalance: monthIn - monthOut }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST add a transaction
app.post('/api/transactions', async (req, res) => {
  const { user_id, type, category, amount, description, party_name, transaction_date, payment_method, reference, notes } = req.body;
  try {
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool2.query(
      `INSERT INTO transactions (user_id,type,category,amount,description,party_name,transaction_date,payment_method,reference,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [user_id, type, category, parseFloat(amount), description, party_name,
       transaction_date || new Date().toISOString().split('T')[0], payment_method || 'UPI', reference, notes]
    );
    await pool2.end();
    res.json({ success: true, transaction: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET financial summary with category breakdown
app.get('/api/financial-summary/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const [totals, monthly, catBreakdown, recent] = await Promise.all([
      pool2.query(`SELECT type, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id=$1 GROUP BY type`, [userId]),
      pool2.query(`SELECT TO_CHAR(transaction_date,'YYYY-MM') as month, type, SUM(amount) as total FROM transactions WHERE user_id=$1 AND transaction_date >= NOW()-INTERVAL '6 months' GROUP BY month,type ORDER BY month DESC`, [userId]),
      pool2.query(`SELECT category, type, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE user_id=$1 GROUP BY category,type ORDER BY total DESC`, [userId]),
      pool2.query(`SELECT * FROM transactions WHERE user_id=$1 ORDER BY transaction_date DESC, created_at DESC LIMIT 5`, [userId]),
    ]);
    await pool2.end();

    const totalIn  = parseFloat(totals.rows.find(r => r.type === 'in')?.total  || 0);
    const totalOut = parseFloat(totals.rows.find(r => r.type === 'out')?.total || 0);
    res.json({
      summary: { totalIn, totalOut, balance: totalIn - totalOut },
      monthly: monthly.rows,
      categories: catBreakdown.rows,
      recentTransactions: recent.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AI Financial Monitor
app.get('/api/ai-financial-monitor/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const [totals, last30, invoiceSummary] = await Promise.all([
      pool2.query(`SELECT type, SUM(amount) as total FROM transactions WHERE user_id=$1 GROUP BY type`, [userId]),
      pool2.query(`SELECT category, type, SUM(amount) as total FROM transactions WHERE user_id=$1 AND transaction_date >= NOW()-INTERVAL '30 days' GROUP BY category,type ORDER BY total DESC`, [userId]),
      pool2.query(`SELECT payment_status, SUM(invoice_amount) as total, COUNT(*) as cnt FROM invoices WHERE user_id=$1 GROUP BY payment_status`, [userId]),
    ]);
    await pool2.end();

    const totalIn  = parseFloat(totals.rows.find(r => r.type === 'in')?.total  || 0);
    const totalOut = parseFloat(totals.rows.find(r => r.type === 'out')?.total || 0);
    const outstanding = parseFloat(invoiceSummary.rows.find(r => r.payment_status === 'Pending')?.total || 0);

    const expenseLines = last30.rows.filter(r => r.type === 'out').map(r => `  - ${r.category}: ₹${parseFloat(r.total).toLocaleString('en-IN')}`).join('\n');
    const incomeLines  = last30.rows.filter(r => r.type === 'in').map(r => `  - ${r.category}: ₹${parseFloat(r.total).toLocaleString('en-IN')}`).join('\n');

    const prompt = `You are a financial AI for an Indian MSME. Analyze this data:
TOTAL: In ₹${totalIn.toLocaleString('en-IN')}, Out ₹${totalOut.toLocaleString('en-IN')}, Balance ₹${(totalIn-totalOut).toLocaleString('en-IN')}
OUTSTANDING INVOICES: ₹${outstanding.toLocaleString('en-IN')}
LAST 30 DAYS EXPENSES:\n${expenseLines || '  (none)'}
LAST 30 DAYS INCOME:\n${incomeLines || '  (none)'}

Return JSON only:
{"health_score":0-100,"status":"healthy|warning|critical","summary":"2-3 sentences","alerts":[{"type":"warning|danger|info","message":"..."}],"insights":[{"title":"...","description":"...","action":"..."}],"top_expenses":[{"category":"...","amount":0,"pct":0}]}`;

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 1200 })
    });
    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    const analysis = match ? JSON.parse(match[0]) : { health_score: 50, status: 'warning', summary: 'Insufficient data.', alerts: [], insights: [], top_expenses: [] };
    res.json({ success: true, analysis });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================
// ORDERS — AI voice order management
// ============================================

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { date, from, to, status } = req.query;
    let query = supabase.from('orders').select('*, workers(name, phone)')
      .eq('user_id', userId).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (from && to) {
      query = query.gte('order_date', from).lte('order_date', to);
    } else {
      const today = new Date().toISOString().split('T')[0];
      query = query.eq('order_date', date || today);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_phone, delivery_address, items, total_amount, delivery_time, special_instructions, worker_id } = req.body;
    const { data, error } = await supabase.from('orders').insert([{
      user_id: userId, customer_name, customer_phone,
      delivery_address, items: items || [], total_amount: total_amount || null,
      delivery_time, special_instructions, worker_id: worker_id || null,
      source: 'manual', status: 'new',
      order_date: new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data, error } = await supabase.from('orders')
      .update({ ...req.body, updated_at: new Date() })
      .eq('id', req.params.id).eq('user_id', userId).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('orders').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// WORKERS — team management
// ============================================

app.get('/api/workers', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('workers')
      .select('*').eq('user_id', req.user.userId).order('name');
    if (error) throw error;
    res.json({ success: true, workers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/workers', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, phone, role } = req.body;
    if (!name) return res.status(400).json({ error: 'Worker name required' });
    const { data, error } = await supabase.from('workers').insert([{
      user_id: userId, name, phone, role: role || 'delivery', is_active: true, created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/workers/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('workers')
      .update(req.body).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/workers/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('workers').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// BUSINESS VOCABULARY — AI Training
// ============================================

app.get('/api/vocabulary', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('business_vocabulary')
      .select('*').eq('user_id', req.user.userId).order('category').order('term');
    if (error) throw error;
    res.json({ success: true, vocabulary: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vocabulary', authMiddleware, async (req, res) => {
  try {
    const { term, meaning, category, aliases } = req.body;
    if (!term || !meaning) return res.status(400).json({ error: 'term and meaning required' });
    const { data, error } = await supabase.from('business_vocabulary').insert([{
      user_id: req.user.userId, term, meaning,
      category: category || 'product', aliases: aliases || [], created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vocabulary/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('business_vocabulary').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Seed starter vocabulary by industry
app.post('/api/vocabulary/seed', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { industry } = req.body;
    const SEEDS = {
      construction: [
        { term: 'Bajri',   meaning: 'Fine river sand for plastering/concrete', aliases: ['bairi','najri','rait'] },
        { term: 'Gitti',   meaning: 'Crushed stone aggregate (10mm/20mm/40mm)', aliases: ['roori','stone chips','gravel'] },
        { term: 'Sariya',  meaning: 'Iron/TMT steel reinforcement rods', aliases: ['rod','lohiya','tmt','steel'] },
        { term: 'Cement',  meaning: 'Portland cement 50kg bags', aliases: ['siement','grey powder'] },
        { term: 'Rait',    meaning: 'General purpose sand', aliases: ['sand','balu'] },
        { term: 'Surkhi',  meaning: 'Brick powder for mortar', aliases: ['brick dust'] },
        { term: 'Eent',    meaning: 'Red clay fired bricks', aliases: ['int','bricks','lakhori'] },
        { term: 'Chuna',   meaning: 'White lime for whitewash or mortar', aliases: ['lime','choona'] },
        { term: 'Khamba',  meaning: 'RCC concrete pillar or post', aliases: ['pillar','column'] },
        { term: 'Brass',   meaning: '100 cubic feet — bulk unit for sand/stone', aliases: ['bras','100 cft'] },
        { term: 'CFT',     meaning: 'Cubic feet — measurement unit for aggregates', category: 'unit', aliases: ['ghanafit'] },
        { term: 'Truck',   meaning: 'Full truck load delivery (~8–10 tonnes)', category: 'unit', aliases: ['truck bhar','gadi bhar'] },
      ],
      textile: [
        { term: 'Thaan',   meaning: 'Full bolt/roll of fabric (~30m or 100m)', category: 'unit', aliases: ['bolt','roll'] },
        { term: 'Gaj',     meaning: 'Yard (≈0.9 metres) for fabric', category: 'unit', aliases: ['yard','gaz'] },
        { term: 'Malmal',  meaning: 'Fine muslin/cotton fabric', aliases: ['muslin','cotton fine'] },
        { term: 'Resham',  meaning: 'Silk fabric', aliases: ['silk'] },
        { term: 'Jeans',   meaning: 'Denim fabric or readymade jeans', aliases: ['denim'] },
      ],
      grocery: [
        { term: 'Bora',    meaning: 'Large 50kg gunny sack', category: 'unit', aliases: ['bori','sack','bag'] },
        { term: 'Peti',    meaning: 'Crate/carton for fruits or goods', category: 'unit', aliases: ['box','carton'] },
        { term: 'Katta',   meaning: '50kg grain sack', category: 'unit', aliases: ['bag','sack'] },
        { term: 'Quintal', meaning: '100 kilograms', category: 'unit', aliases: ['kwintal'] },
        { term: 'Tray',    meaning: 'Tray of eggs (30 pieces)', category: 'unit', aliases: ['egg tray'] },
      ],
      pharma: [
        { term: 'Strip',   meaning: 'Strip of tablets/capsules (typically 10)', category: 'unit', aliases: ['patti'] },
        { term: 'Vial',    meaning: 'Glass vial for injectable medicines', category: 'product', aliases: ['bottle'] },
        { term: 'Expiry',  meaning: 'Expiry date on medicines', category: 'process', aliases: ['exp','mfg'] },
      ],
    };
    const items = (SEEDS[industry] || []).map(s => ({
      user_id: userId, term: s.term, meaning: s.meaning,
      category: s.category || 'product', aliases: s.aliases || [], created_at: new Date()
    }));
    if (items.length === 0) return res.json({ success: true, seeded: 0 });
    const { error } = await supabase.from('business_vocabulary').insert(items);
    if (error) throw error;
    res.json({ success: true, seeded: items.length, industry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// AI INBOUND CALL — Voice Order Extraction
// ============================================

// STEP 1 — Owner sets Twilio webhook URL to:
//   https://vantro-flow-backend-production.up.railway.app/api/voice/inbound?uid=USER_ID
app.post('/api/voice/inbound', async (req, res) => {
  try {
    const userId = req.query.uid;
    let greeting = 'Vantro Business';
    if (userId) {
      const { data: u } = await supabase.from('users')
        .select('business_name, owner_name').eq('id', userId).single();
      if (u?.business_name) greeting = u.business_name;
    }
    const cbUrl = `${process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app'}/api/voice/recording?uid=${userId || ''}`;
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">Namaste! ${greeting.replace(/&/g,'and')} mein aapka swagat hai. Beep ke baad apna order boliye — apna naam, kya chahiye, kitna chahiye, aur address batayein.</Say>
  <Record maxLength="180" action="${cbUrl}" transcribe="false" playBeep="true" finishOnKey="*"/>
  <Say voice="Polly.Aditi" language="hi-IN">Dhanyavaad! Aapka order note ho gaya. Hum jald sampark karenge.</Say>
</Response>`);
  } catch (err) {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>System busy, please try again.</Say></Response>`);
  }
});

// STEP 2 — Twilio POSTs here when recording is ready
app.post('/api/voice/recording', async (req, res) => {
  res.sendStatus(200); // Respond immediately — process async

  const userId = req.query.uid;
  const { RecordingUrl, RecordingSid, From: callerPhone } = req.body;
  if (!RecordingUrl || !userId) return;

  try {
    // 1. Download MP3 from Twilio (auth required)
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const recRes = await fetch(`${RecordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
    if (!recRes.ok) throw new Error(`Recording download failed: ${recRes.status}`);
    const audioBuf = Buffer.from(await recRes.arrayBuffer());

    // 2. Transcribe with Groq Whisper (hi = Hindi/Hinglish)
    const fd = new FormData();
    fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'order.mp3');
    fd.append('model', 'whisper-large-v3');
    fd.append('language', 'hi');
    fd.append('response_format', 'text');

    const trRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: fd,
    });
    const transcript = trRes.ok ? (await trRes.text()).trim() : '';
    if (!transcript || transcript.length < 5) {
      console.log(`⚠️ Empty transcript for ${RecordingSid}`);
      return;
    }
    console.log(`📞 Call transcript (user ${userId}): ${transcript}`);

    // 3. Load vocabulary + user profile for context
    const [{ data: vocab }, { data: profile }] = await Promise.all([
      supabase.from('business_vocabulary').select('term,meaning,aliases').eq('user_id', userId),
      supabase.from('users').select('business_name,city,business_type,owner_name,ai_persona').eq('id', userId).single(),
    ]);

    const vocabLines = (vocab || []).map(v =>
      `• ${v.term} = ${v.meaning}${v.aliases?.length ? ` (also called: ${v.aliases.join(', ')})` : ''}`
    ).join('\n');

    // 4. Extract order with Groq LLaMA + vocabulary context
    const systemPrompt = `You are an AI order extraction assistant for an Indian MSME.
Business: ${profile?.business_name || 'Business'}, Location: ${profile?.city || 'India'}
Caller phone: ${callerPhone || 'unknown'}
${vocabLines ? `\nBUSINESS VOCABULARY (map caller's local terms to these):\n${vocabLines}` : ''}
Extract order from Hindi/Hinglish transcript. Return ONLY valid JSON, no commentary.`;

    const userPrompt = `Transcript: "${transcript}"\n\nReturn JSON:\n{"customer_name":null,"customer_phone":null,"delivery_address":null,"items":[{"name":"standard name","local_name":"as said","quantity":1,"unit":"piece"}],"delivery_time":null,"special_instructions":null,"confidence":80,"summary":"one line in Hinglish"}`;

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 500,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
    });
    const aiJson = await aiRes.json();
    const raw = aiJson.choices?.[0]?.message?.content || '{}';
    let extracted = {};
    try { const m = raw.match(/\{[\s\S]*\}/); extracted = m ? JSON.parse(m[0]) : {}; } catch (_) {}

    // 5. Save order to DB
    const orderPayload = {
      user_id: userId,
      customer_name: extracted.customer_name || callerPhone || 'Unknown',
      customer_phone: extracted.customer_phone || (callerPhone ? callerPhone.replace('+91', '').replace(/\D/g, '') : null),
      delivery_address: extracted.delivery_address || null,
      items: extracted.items || [],
      delivery_time: extracted.delivery_time || null,
      special_instructions: extracted.special_instructions || null,
      call_recording_url: RecordingUrl,
      call_transcript: transcript,
      source: 'ai_call',
      status: 'new',
      order_date: new Date().toISOString().split('T')[0],
      created_at: new Date(),
    };
    const { data: savedOrder } = await supabase.from('orders').insert([orderPayload]).select().single();

    // 6. Push notification to owner
    if (savedOrder) {
      await sendPushToUser(userId,
        '📞 Naya Order Aaya — Call Se!',
        `${extracted.customer_name || callerPhone}: ${extracted.summary || (extracted.items?.[0] ? `${extracted.items[0].quantity} ${extracted.items[0].unit} ${extracted.items[0].name}` : 'Order received')}`,
        { type: 'new_order', order_id: savedOrder.id }
      );
    }

    // 7. Auto-call first active worker (if Twilio configured)
    if (twilioClient && savedOrder) {
      const { data: workers } = await supabase.from('workers')
        .select('name, phone').eq('user_id', userId).eq('is_active', true).limit(1);

      if (workers?.[0]?.phone) {
        const w = workers[0];
        const wPhone = String(w.phone).replace(/\D/g, '');
        const toPhone = wPhone.length === 10 ? `+91${wPhone}` : `+${wPhone}`;
        const itemsDesc = (extracted.items || []).map(i => `${i.quantity} ${i.unit} ${i.local_name || i.name}`).join(', ');
        const script = `${w.name} ji, naya order aaya hai. Customer: ${extracted.customer_name || 'customer'}. Maal: ${itemsDesc || 'details app mein hain'}. Address: ${extracted.delivery_address || 'confirm karo'}. Delivery: ${extracted.delivery_time || 'jaldi se'}. Vantro app check karo.`;
        const safe = script.replace(/&/g,'and').replace(/</g,'').replace(/>/g,'');
        try {
          await twilioClient.calls.create({
            to: toPhone, from: process.env.TWILIO_PHONE_NUMBER,
            twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">${safe}</Say></Response>`,
            timeout: 20,
          });
        } catch (ce) { console.error('Worker auto-call error:', ce.message); }
      }
    }
    console.log(`✅ Order from call saved — user ${userId}`);
  } catch (err) {
    console.error('Recording processing error:', err.message);
  }
});

// Get inbound call webhook URL for this user
app.get('/api/voice/webhook-url', authMiddleware, (req, res) => {
  const base = process.env.RAILWAY_PUBLIC_URL || 'https://vantro-flow-backend-production.up.railway.app';
  const url = `${base}/api/voice/inbound?uid=${req.user.userId}`;
  const twilioConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  res.json({ success: true, webhook_url: url, twilio_configured: twilioConfigured });
});

// ============================================
// EXPENSES — daily tracking
// ============================================

const EXPENSE_CATEGORIES = ['transport','fuel','salary','material','rent','electricity','maintenance','marketing','misc'];

app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { date, from, to } = req.query;
    let q = supabase.from('expenses').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (from && to) q = q.gte('expense_date', from).lte('expense_date', to);
    else q = q.eq('expense_date', date || new Date().toISOString().split('T')[0]);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, expenses: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { description, amount, category, notes } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'description and amount required' });
    const { data, error } = await supabase.from('expenses').insert([{
      user_id: req.user.userId, description, amount: parseFloat(amount),
      category: category || 'misc', notes: notes || null,
      expense_date: new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, expense: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/expenses/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('expenses')
      .update(req.body).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, expense: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('expenses').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// TODAY SUMMARY — P&L aggregator
// ============================================

app.get('/api/today/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const [
      { data: orders },
      { data: expenses },
      { data: paidInvoices },
      { data: callLogs },
    ] = await Promise.all([
      supabase.from('orders').select('*').eq('user_id', userId).eq('order_date', date),
      supabase.from('expenses').select('*').eq('user_id', userId).eq('expense_date', date),
      supabase.from('invoices').select('*').eq('user_id', userId).gte('paid_at', date + 'T00:00:00').lte('paid_at', date + 'T23:59:59'),
      supabase.from('call_logs').select('*').eq('user_id', userId).gte('created_at', date + 'T00:00:00').lte('created_at', date + 'T23:59:59'),
    ]);

    const orderIncome = (orders || [])
      .filter(o => !['cancelled'].includes(o.status))
      .reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

    const invoiceIncome = (paidInvoices || [])
      .reduce((s, i) => s + Number(i.invoice_amount || 0), 0);

    const totalIncome = orderIncome + invoiceIncome;
    const totalExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
    const netProfit = totalIncome - totalExpenses;

    // Top selling items from orders
    const itemMap = {};
    (orders || []).forEach(o => {
      (o.items || []).forEach((item) => {
        const key = item.name || item.local_name || 'Unknown';
        itemMap[key] = (itemMap[key] || 0) + (item.quantity || 0);
      });
    });
    const topItems = Object.entries(itemMap)
      .sort(([,a],[,b]) => b - a).slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    // Expense breakdown by category
    const expenseByCategory = {};
    (expenses || []).forEach(e => {
      expenseByCategory[e.category] = (expenseByCategory[e.category] || 0) + Number(e.amount || 0);
    });

    res.json({
      success: true,
      date,
      summary: {
        income: { orders: orderIncome, invoices: invoiceIncome, total: totalIncome },
        expenses: { total: totalExpenses, by_category: expenseByCategory },
        net_profit: netProfit,
        order_count: (orders || []).length,
        orders_by_status: {
          new: (orders || []).filter(o => o.status === 'new').length,
          confirmed: (orders || []).filter(o => o.status === 'confirmed').length,
          dispatched: (orders || []).filter(o => o.status === 'dispatched').length,
          delivered: (orders || []).filter(o => o.status === 'delivered').length,
          cancelled: (orders || []).filter(o => o.status === 'cancelled').length,
        },
        invoices_collected: (paidInvoices || []).length,
        calls_made: (callLogs || []).length,
        top_items: topItems,
      },
      orders: orders || [],
      expenses: expenses || [],
      paid_invoices: paidInvoices || [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// VANTRO BRAIN — Specialized Business AI
// ============================================

// Brain rules — business-specific knowledge owner teaches AI
app.get('/api/ai/brain/rules', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('brain_rules').select('*').eq('user_id', req.user.userId).order('created_at');
    if (error) throw error;
    res.json({ success: true, rules: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/brain/rules', authMiddleware, async (req, res) => {
  try {
    const { rule, category } = req.body;
    if (!rule) return res.status(400).json({ error: 'rule required' });
    const { data, error } = await supabase.from('brain_rules').insert([{
      user_id: req.user.userId, rule, category: category || 'general', created_at: new Date()
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, rule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ai/brain/rules/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('brain_rules').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Main Vantro Brain endpoint — full context AI with live tool use
app.post('/api/ai/brain', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Load all business context in parallel
    const today = new Date().toISOString().split('T')[0];
    const [
      { data: profile },
      { data: vocab },
      { data: rules },
      { data: workers },
      { data: topInvoices },
      { data: todayOrders },
      { data: todayExpenses },
    ] = await Promise.all([
      supabase.from('users').select('business_name,city,business_type,owner_name,voice_style,ai_persona').eq('id', userId).single(),
      supabase.from('business_vocabulary').select('term,meaning,aliases').eq('user_id', userId).limit(50),
      supabase.from('brain_rules').select('rule,category').eq('user_id', userId).limit(30),
      supabase.from('workers').select('name,role,is_active').eq('user_id', userId),
      supabase.from('invoices').select('customer_name,invoice_amount,due_date,status').eq('user_id', userId).eq('status','unpaid').order('invoice_amount', { ascending: false }).limit(10),
      supabase.from('orders').select('customer_name,items,status,total_amount,delivery_time').eq('user_id', userId).eq('order_date', today),
      supabase.from('expenses').select('description,amount,category').eq('user_id', userId).eq('expense_date', today),
    ]);

    // Build today's numbers for context
    const todayIncome = (todayOrders || []).filter(o => o.status !== 'cancelled').reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const todaySpend = (todayExpenses || []).reduce((s, e) => s + Number(e.amount || 0), 0);
    const pendingAmount = (topInvoices || []).reduce((s, i) => s + Number(i.invoice_amount || 0), 0);

    // Vocabulary context
    const vocabText = (vocab || []).length > 0
      ? '\n\nBUSINESS VOCABULARY:\n' + (vocab || []).map(v => `• ${v.term} = ${v.meaning}${v.aliases?.length ? ` (also: ${v.aliases.join(', ')})` : ''}`).join('\n')
      : '';

    // Owner-taught business rules
    const rulesText = (rules || []).length > 0
      ? '\n\nOWNER\'S BUSINESS RULES (always follow these):\n' + (rules || []).map(r => `• [${r.category}] ${r.rule}`).join('\n')
      : '';

    // Live business snapshot
    const snapshot = `
LIVE BUSINESS SNAPSHOT (right now):
• Business: ${profile?.business_name || 'Business'}, ${profile?.city || 'India'}
• Today ${today}:
  - Orders today: ${(todayOrders || []).length} (income: ₹${todayIncome.toLocaleString('en-IN')})
  - Expenses today: ₹${todaySpend.toLocaleString('en-IN')}
  - Net today: ₹${(todayIncome - todaySpend).toLocaleString('en-IN')}
• Outstanding receivables: ₹${pendingAmount.toLocaleString('en-IN')} from ${(topInvoices || []).length} parties
• Top pending: ${(topInvoices || []).slice(0, 3).map(i => `${i.customer_name} ₹${Number(i.invoice_amount).toLocaleString('en-IN')}`).join(', ') || 'none'}
• Today's orders: ${(todayOrders || []).map(o => `${o.customer_name}(${o.status})`).join(', ') || 'none'}
• Team: ${(workers || []).filter(w => w.is_active).map(w => w.name).join(', ') || 'no workers yet'}`;

    // Voice/persona context
    const styleDesc = { casual_hinglish:'Mix of Hindi + English (Hinglish)', formal_hindi:'Formal Hindi', direct_english:'Direct English', friendly_urdu:'Friendly Urdu-influenced', regional_hindi:'Regional Hindi dialect' }[profile?.voice_style || ''] || 'Hinglish';
    const voiceCtx = profile?.owner_name ? `\nSPEAK TO OWNER AS: ${profile.owner_name} ji. Style: ${styleDesc}. ${profile?.ai_persona ? 'Their style: ' + profile.ai_persona : ''}` : '';

    const systemPrompt = `You are Vantro Brain — a specialized AI built exclusively for this Indian MSME business.
You are NOT a generic AI. You know this business inside-out: every customer, every product, every rule.
You speak in Hinglish (mix of Hindi + English) naturally, like a knowledgeable business partner.
${voiceCtx}
${snapshot}
${vocabText}
${rulesText}

WHAT YOU CAN DO:
- Answer any business question using the live data above
- Calculate P&L, outstanding, recovery rates on the fly
- Suggest which customer to call first, what to do next
- Track and reason about orders, expenses, invoices
- Give brutally honest business advice

RULES:
- Always use ₹ for amounts, Indian number format (lakhs/crores)
- Be direct and action-oriented — no fluff
- If you don't know something specific, say so and suggest how to find it
- Keep answers concise unless asked for detail
- End responses with a clear next action when relevant`;

    // Tool definitions for live DB queries
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_invoices',
          description: 'Fetch unpaid invoices with filtering',
          parameters: {
            type: 'object',
            properties: {
              sort_by: { type: 'string', enum: ['amount', 'days_overdue'], default: 'amount' },
              limit: { type: 'integer', default: 10 },
              min_amount: { type: 'number', description: 'Minimum invoice amount filter' },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_orders_by_date',
          description: 'Get orders for a specific date',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD, default today' },
              status: { type: 'string', enum: ['new','confirmed','dispatched','delivered','cancelled'] },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_expenses_summary',
          description: 'Get expense breakdown for a date range',
          parameters: {
            type: 'object',
            properties: {
              from_date: { type: 'string', description: 'YYYY-MM-DD start' },
              to_date: { type: 'string', description: 'YYYY-MM-DD end' },
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_customer',
          description: 'Search for a specific customer across invoices and orders',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_expense',
          description: 'Add a new expense entry for today',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              amount: { type: 'number' },
              category: { type: 'string', enum: EXPENSE_CATEGORIES },
            },
            required: ['description', 'amount']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_top_customers',
          description: 'Get customers ranked by outstanding amount or order history',
          parameters: {
            type: 'object',
            properties: {
              ranked_by: { type: 'string', enum: ['outstanding', 'orders'], default: 'outstanding' },
              limit: { type: 'integer', default: 5 }
            }
          }
        }
      }
    ];

    // Tool execution handlers
    const execTool = async (name, args) => {
      switch (name) {
        case 'get_invoices': {
          const order = args.sort_by === 'days_overdue' ? 'due_date' : 'invoice_amount';
          let q = supabase.from('invoices').select('customer_name,invoice_amount,due_date,status')
            .eq('user_id', userId).eq('status', 'unpaid').order(order, { ascending: false }).limit(args.limit || 10);
          if (args.min_amount) q = q.gte('invoice_amount', args.min_amount);
          const { data } = await q;
          return (data || []).map(i => ({
            customer: i.customer_name,
            amount: `₹${Number(i.invoice_amount).toLocaleString('en-IN')}`,
            due: i.due_date,
            overdue_days: i.due_date ? Math.max(0, Math.floor((Date.now() - new Date(i.due_date).getTime()) / 86400000)) : null
          }));
        }
        case 'get_orders_by_date': {
          const d = args.date || today;
          let q = supabase.from('orders').select('customer_name,items,status,total_amount,delivery_time,created_at')
            .eq('user_id', userId).eq('order_date', d);
          if (args.status) q = q.eq('status', args.status);
          const { data } = await q.order('created_at', { ascending: false });
          return data || [];
        }
        case 'get_expenses_summary': {
          const from = args.from_date || today;
          const to = args.to_date || today;
          const { data } = await supabase.from('expenses').select('description,amount,category,expense_date')
            .eq('user_id', userId).gte('expense_date', from).lte('expense_date', to);
          const total = (data || []).reduce((s, e) => s + Number(e.amount || 0), 0);
          const byCategory = {};
          (data || []).forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount); });
          return { total: `₹${total.toLocaleString('en-IN')}`, by_category: byCategory, items: data || [] };
        }
        case 'search_customer': {
          const term = `%${args.name}%`;
          const [invRes, ordRes] = await Promise.all([
            supabase.from('invoices').select('customer_name,invoice_amount,status,due_date').eq('user_id', userId).ilike('customer_name', term).limit(5),
            supabase.from('orders').select('customer_name,items,status,total_amount,order_date').eq('user_id', userId).ilike('customer_name', term).limit(5),
          ]);
          return { invoices: invRes.data || [], orders: ordRes.data || [] };
        }
        case 'add_expense': {
          const { data } = await supabase.from('expenses').insert([{
            user_id: userId, description: args.description, amount: args.amount,
            category: args.category || 'misc', expense_date: today, created_at: new Date()
          }]).select().single();
          return { added: true, expense: data };
        }
        case 'get_top_customers': {
          if (args.ranked_by === 'orders') {
            const { data } = await supabase.from('orders').select('customer_name,total_amount').eq('user_id', userId).not('status', 'eq', 'cancelled');
            const map = {};
            (data || []).forEach(o => { map[o.customer_name] = (map[o.customer_name] || 0) + Number(o.total_amount || 0); });
            return Object.entries(map).sort(([,a],[,b]) => b-a).slice(0, args.limit || 5).map(([name, total]) => ({ name, total: `₹${total.toLocaleString('en-IN')}` }));
          } else {
            const { data } = await supabase.from('invoices').select('customer_name,invoice_amount').eq('user_id', userId).eq('status','unpaid').order('invoice_amount', { ascending: false }).limit(args.limit || 5);
            return data || [];
          }
        }
        default: return { error: 'Unknown tool' };
      }
    };

    // Agentic loop — up to 4 tool call rounds
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-20),
      { role: 'user', content: message },
    ];

    let finalResponse = '';
    const toolsUsed = [];

    for (let round = 0; round < 4; round++) {
      const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });
      const aiData = await aiRes.json();
      const choice = aiData.choices?.[0];
      if (!choice) break;

      if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (_) {}
          const result = await execTool(tc.function.name, args);
          toolsUsed.push(tc.function.name);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        finalResponse = choice.message?.content || '';
        break;
      }
    }

    if (!finalResponse) finalResponse = 'Kuch technical issue aa gaya, please dobara try karo.';

    // Return new history (user+assistant pair only, no system/tools)
    const newHistory = [
      ...(history || []).slice(-18),
      { role: 'user', content: message },
      { role: 'assistant', content: finalResponse },
    ];

    res.json({ success: true, response: finalResponse, history: newHistory, tools_used: toolsUsed });
  } catch (err) {
    console.error('Brain error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// FEATURE FLAGS — industry-based smart setup
// ============================================

function buildFeatureFlags({ industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain }) {
  const isProduct = ['construction','textile','grocery','pharma','electronics','manufacturing','trading','hardware','auto_parts','furniture'].includes(industry);
  const isService = ['services','consulting','salon','clinic','coaching','agency'].includes(industry);
  return {
    dashboard: true, collections: true, whatsapp: true, ai_chat: true,
    today_pl: true, brain: true, analytics: true, forecast: true,
    reports: true, network: true, crm: true, ledger: true,
    gst_invoices: gst_registered || true,           // most MSMEs need bills
    khata: sells_on_credit || true,                 // credit is universal
    purchases: isProduct,                           // buying stock
    attendance: has_workers,                        // only if they have staff
    orders: isProduct,                              // order management
    ai_calling: isProduct,                          // voice orders
    inventory: isProduct,                           // stock tracking
    scanner: gst_registered,                        // invoice scanner
    dunning: sells_on_credit,                       // auto follow-up
    gstr_export: gst_registered,                    // GSTR-1 export
    neural_engine: sells_on_credit,                 // ML prioritization
    billing_feature: true,
  };
}

app.post('/api/onboarding/setup', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain, gstin, business_address, owner_name, city } = req.body;
    const feature_flags = buildFeatureFlags({ industry, business_size, gst_registered, sells_on_credit, has_workers, primary_pain });
    await supabase.from('users').update({
      industry, business_size, gst_registered, gstin: gstin || null,
      business_address: business_address || null, feature_flags,
      owner_name: owner_name || null, city: city || null,
    }).eq('id', userId);
    await supabase.from('business_vocabulary').upsert(
      [{user_id: userId, term: 'Industry', meaning: industry, category: 'process', aliases: [], created_at: new Date()}],
      { onConflict: 'user_id,term' }
    );
    res.json({ success: true, feature_flags });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/features', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('feature_flags, industry, business_size, gst_registered, owner_name, city, gstin, business_name, business_address').eq('id', req.user.userId).single();
    res.json({ success: true, ...(data || {}), feature_flags: data?.feature_flags || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// GST BILLS / INVOICES
// ============================================

// Public endpoint — no auth — for sharing invoice URL
app.get('/api/bills/public/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('bills').select('*, users(business_name, gstin, city, business_address, owner_name)').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true, bill: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bills', authMiddleware, async (req, res) => {
  try {
    const { status, from, to, limit = 50 } = req.query;
    let q = supabase.from('bills').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false }).limit(Number(limit));
    if (status) q = q.eq('status', status);
    if (from) q = q.gte('bill_date', from);
    if (to) q = q.lte('bill_date', to);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, bills: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bills', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customer_name, customer_gstin, customer_address, customer_phone, items, is_interstate, due_date, notes } = req.body;
    if (!customer_name || !items?.length) return res.status(400).json({ error: 'customer_name and items required' });

    // Auto-generate bill number
    const { data: lastBill } = await supabase.from('bills').select('bill_number').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).single();
    let nextNum = 1;
    if (lastBill?.bill_number) { const m = lastBill.bill_number.match(/(\d+)$/); if (m) nextNum = parseInt(m[1]) + 1; }
    const y = new Date().getFullYear();
    const bill_number = `INV-${y}-${String(nextNum).padStart(4, '0')}`;

    // Calculate totals
    let subtotal = 0;
    const enrichedItems = items.map(item => {
      const amount = parseFloat(item.quantity || 1) * parseFloat(item.rate || 0);
      subtotal += amount;
      return { ...item, amount: Math.round(amount * 100) / 100 };
    });

    const gstRate = parseFloat(req.body.gst_rate || 18);
    const gstAmt = (subtotal * gstRate) / 100;
    const cgst = is_interstate ? 0 : gstAmt / 2;
    const sgst = is_interstate ? 0 : gstAmt / 2;
    const igst = is_interstate ? gstAmt : 0;
    const total = subtotal + gstAmt;

    const { data, error } = await supabase.from('bills').insert([{
      user_id: userId, bill_number, customer_name, customer_gstin: customer_gstin || null,
      customer_address: customer_address || null, customer_phone: customer_phone || null,
      items: enrichedItems, gst_rate: gstRate, subtotal: Math.round(subtotal * 100) / 100,
      cgst: Math.round(cgst * 100) / 100, sgst: Math.round(sgst * 100) / 100,
      igst: Math.round(igst * 100) / 100, total: Math.round(total * 100) / 100,
      is_interstate: !!is_interstate, due_date: due_date || null,
      notes: notes || null, status: 'unpaid', bill_date: new Date().toISOString().split('T')[0],
      created_at: new Date(),
    }]).select().single();
    if (error) throw error;

    // Also create a receivable invoice for collections tracking
    await supabase.from('invoices').insert([{
      user_id: userId, customer_name, invoice_amount: total,
      due_date: due_date || null, status: 'unpaid',
      notes: `Bill ${bill_number}`, created_at: new Date(),
    }]).select();

    res.json({ success: true, bill: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/bills/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('bills').update(req.body).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, bill: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bills/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('bills').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GSTR-1 export data
app.get('/api/bills/gstr1', authMiddleware, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');
    const y = year || new Date().getFullYear();
    const from = `${y}-${m}-01`;
    const to = `${y}-${m}-31`;
    const { data: bills } = await supabase.from('bills').select('*').eq('user_id', req.user.userId).gte('bill_date', from).lte('bill_date', to).eq('status', 'unpaid').neq('status', 'cancelled');
    const b2b = (bills || []).filter(b => b.customer_gstin).map(b => ({
      'GSTIN of Recipient': b.customer_gstin, 'Receiver Name': b.customer_name,
      'Invoice Number': b.bill_number, 'Invoice Date': b.bill_date,
      'Invoice Value': b.total, 'Taxable Value': b.subtotal,
      'CGST': b.cgst, 'SGST': b.sgst, 'IGST': b.igst, 'GST Rate': b.gst_rate + '%',
    }));
    const b2c = (bills || []).filter(b => !b.customer_gstin).map(b => ({
      'Customer Name': b.customer_name, 'Invoice Number': b.bill_number,
      'Invoice Date': b.bill_date, 'Invoice Value': b.total,
      'Taxable Value': b.subtotal, 'CGST': b.cgst, 'SGST': b.sgst, 'IGST': b.igst,
    }));
    const totalTax = (bills || []).reduce((s, b) => s + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.igst || 0), 0);
    const totalSales = (bills || []).reduce((s, b) => s + Number(b.total || 0), 0);
    res.json({ success: true, month: `${m}/${y}`, b2b, b2c, summary: { total_invoices: (bills||[]).length, total_sales: totalSales, total_tax: totalTax } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// KHATA — Customer Udhaar / Credit Ledger
// ============================================

app.get('/api/khata', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('khata_entries').select('*').eq('user_id', req.user.userId).order('entry_date', { ascending: false });
    if (error) throw error;
    // Group by customer with running balance
    const customers = {};
    (data || []).forEach(e => {
      if (!customers[e.customer_name]) customers[e.customer_name] = { customer_name: e.customer_name, balance: 0, entries: [], last_entry: e.entry_date };
      const amt = Number(e.amount);
      customers[e.customer_name].balance += e.type === 'debit' ? amt : -amt;
      customers[e.customer_name].entries.push(e);
      if (e.entry_date > customers[e.customer_name].last_entry) customers[e.customer_name].last_entry = e.entry_date;
    });
    res.json({ success: true, customers: Object.values(customers).sort((a, b) => b.balance - a.balance) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/khata/:customer', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('khata_entries').select('*')
      .eq('user_id', req.user.userId).eq('customer_name', decodeURIComponent(req.params.customer))
      .order('entry_date', { ascending: true });
    if (error) throw error;
    let balance = 0;
    const entries = (data || []).map(e => {
      balance += e.type === 'debit' ? Number(e.amount) : -Number(e.amount);
      return { ...e, running_balance: balance };
    });
    res.json({ success: true, entries, balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/khata/entry', authMiddleware, async (req, res) => {
  try {
    const { customer_name, type, amount, payment_mode, notes, entry_date } = req.body;
    if (!customer_name || !type || !amount) return res.status(400).json({ error: 'customer_name, type, amount required' });
    const { data, error } = await supabase.from('khata_entries').insert([{
      user_id: req.user.userId, customer_name, type, amount: parseFloat(amount),
      payment_mode: payment_mode || 'cash', notes: notes || null,
      entry_date: entry_date || new Date().toISOString().split('T')[0], created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, entry: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/khata/entry/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('khata_entries').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// PURCHASES — Payables / Supplier dues
// ============================================

app.get('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from('purchases').select('*').eq('user_id', req.user.userId).order('due_date', { ascending: true });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, purchases: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/purchases', authMiddleware, async (req, res) => {
  try {
    const { supplier_name, amount, due_date, description, category, supplier_gstin, notes } = req.body;
    if (!supplier_name || !amount) return res.status(400).json({ error: 'supplier_name and amount required' });
    const { data, error } = await supabase.from('purchases').insert([{
      user_id: req.user.userId, supplier_name, amount: parseFloat(amount), paid_amount: 0,
      due_date: due_date || null, description: description || null,
      category: category || 'material', supplier_gstin: supplier_gstin || null,
      notes: notes || null, status: 'unpaid', purchase_date: new Date().toISOString().split('T')[0],
      created_at: new Date(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, purchase: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/purchases/:id', authMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    // Auto-update status based on paid_amount
    if (updates.paid_amount !== undefined) {
      const { data: existing } = await supabase.from('purchases').select('amount').eq('id', req.params.id).single();
      if (existing) {
        const paid = parseFloat(updates.paid_amount);
        const total = parseFloat(existing.amount);
        updates.status = paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
      }
    }
    const { data, error } = await supabase.from('purchases').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, purchase: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/purchases/:id', authMiddleware, async (req, res) => {
  try {
    await supabase.from('purchases').delete().eq('id', req.params.id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// ATTENDANCE + SALARY
// ============================================

app.get('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const year = req.query.year || new Date().getFullYear();
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-31`;
    const [{ data: workers }, { data: attendance }] = await Promise.all([
      supabase.from('workers').select('*').eq('user_id', req.user.userId).eq('is_active', true),
      supabase.from('attendance').select('*').eq('user_id', req.user.userId).gte('attendance_date', from).lte('attendance_date', to),
    ]);
    res.json({ success: true, workers: workers || [], attendance: attendance || [], month, year });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const { worker_id, attendance_date, status } = req.body;
    if (!worker_id || !attendance_date) return res.status(400).json({ error: 'worker_id and date required' });
    const { data, error } = await supabase.from('attendance').upsert([{
      user_id: req.user.userId, worker_id, attendance_date, status: status || 'present', created_at: new Date(),
    }], { onConflict: 'worker_id,attendance_date' }).select().single();
    if (error) throw error;
    res.json({ success: true, attendance: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/salary', authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const year = req.query.year || new Date().getFullYear();
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-31`;
    const [{ data: workers }, { data: attendance }] = await Promise.all([
      supabase.from('workers').select('*').eq('user_id', req.user.userId).eq('is_active', true),
      supabase.from('attendance').select('*').eq('user_id', req.user.userId).gte('attendance_date', from).lte('attendance_date', to),
    ]);
    // Count working days in month
    const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
    const salaries = (workers || []).map(w => {
      const wAttendance = (attendance || []).filter(a => a.worker_id === w.id);
      const present = wAttendance.filter(a => a.status === 'present').length;
      const half = wAttendance.filter(a => a.status === 'half_day').length;
      const effectiveDays = present + (half * 0.5);
      const baseSalary = parseFloat(w.monthly_salary || 0);
      const earned = daysInMonth > 0 ? (effectiveDays / daysInMonth) * baseSalary : 0;
      const advance = parseFloat(w.advance_balance || 0);
      const net = Math.max(0, earned - advance);
      return { ...w, present_days: present, half_days: half, effective_days: effectiveDays, total_days: daysInMonth, earned_salary: Math.round(earned), advance_deducted: advance, net_salary: Math.round(net) };
    });
    res.json({ success: true, salaries, month, year });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/workers/:id/salary', authMiddleware, async (req, res) => {
  try {
    const { monthly_salary, advance_balance } = req.body;
    const updates = {};
    if (monthly_salary !== undefined) updates.monthly_salary = parseFloat(monthly_salary);
    if (advance_balance !== undefined) updates.advance_balance = parseFloat(advance_balance);
    const { data, error } = await supabase.from('workers').update(updates).eq('id', req.params.id).eq('user_id', req.user.userId).select().single();
    if (error) throw error;
    res.json({ success: true, worker: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`✅ Vantro Flow Backend running on port ${PORT}`);
  console.log(`📝 API Base URL: http://localhost:${PORT}`);
});
