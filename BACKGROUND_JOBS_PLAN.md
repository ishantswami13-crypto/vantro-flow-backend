# Background Jobs & Async Queue Roadmap (Vantro Flow)

This document establishes the architecture for shifting heavy, expensive, or third-party operations out of the user’s HTTP request-response cycle and into managed background workers.

---

## 1. Async Job Candidates

The following workloads are critical candidates to move to background queues:

*   **AI Briefing & Deep Insights**: Takes 3-10 seconds of LLM network round-trip time.
*   **Invoice & Document Parsing (OCR)**: Heavy PDF/Image CPU processing.
*   **WhatsApp Reminders & Broadcast Messages**: Avoid blockages due to Twilio/WATI/Interakt API rate limits.
*   **Ledger Reconciliation & Backfill (`ensureConnectedBusinessData`)**: Massive multi-query loops.
*   **Report Generation & Export (PDF/Excel)**: Heavy file-system and DB operations.

---

## 2. Queue Tooling Evaluation

We evaluate several potential solutions to transition Vantro Flow from in-memory promises to dedicated background queues:

| Technology | Rationale / Why Needed | Monthly Cost | Complexity | When to Add |
| :--- | :--- | :--- | :--- | :--- |
| **pg-boss** | Runs queues directly inside PostgreSQL using job tables. Perfect for medium workloads without adding infrastructure. | **$0** (uses existing database) | **Low** | *Next Milestone* (Immediately when async jobs are approved) |
| **BullMQ + Redis** | Industry standard for high-throughput Node.js queues. Handles millions of jobs, delayed executions, and parent-child flows. | **$10 - $20** (Railway Redis Add-on) | **Medium** | *1,000+ Active Users Scale* |
| **Railway Workers** | Isolated backend containers dedicated to reading the queue, preserving Express API thread resources. | **$5 - $10** (VCPU scale) | **Medium** | *1,000+ Active Users Scale* |
| **Temporal.io** | Advanced orchestration for complex transactional workflows (e.g., dunning retry state machine over 30 days). | **$50+** (Hosted Cloud) | **High** | *Enterprise/High Traffic Scale* |

---

## 3. Recommended pg-boss Queue Architecture (Medium Term)

Since the database is Postgres (via Supabase), using **pg-boss** allows us to build a queue with **zero extra paid infrastructure**.

### Conceptual pg-boss Worker Implementation

```javascript
const PgBoss = require('pg-boss');
const boss = new PgBoss(process.env.DATABASE_URL);

async function startQueue() {
  await boss.start();
  
  // Register worker for invoice parsing
  await boss.work('invoice-ocr', async (job) => {
    const { fileBuffer, userId } = job.data;
    const parsedData = await parseInvoiceDocument(fileBuffer);
    await saveParsedInvoiceToDB(userId, parsedData);
  });
}

// In Express route:
app.post('/api/scan-document', async (req, res) => {
  const jobId = await boss.send('invoice-ocr', { fileBuffer: req.file.buffer, userId: req.user.userId });
  res.json({ success: true, jobId, message: 'Processing started in background' });
});
```

---

## 4. Rollout & Integration Plan
1.  **Step 1**: Implement `pg-boss` staging worker. Shift the heavy `reconcile` and `scan-document` tasks onto pg-boss queues.
2.  **Step 2**: Create an isolated container service on Railway (`vantro-flow-worker`) running the exact same backend code but starting strictly in `worker` mode (running queues instead of listening on standard ports).
3.  **Step 3**: Introduce Sentry Alert integrations specifically for queue task failures.
