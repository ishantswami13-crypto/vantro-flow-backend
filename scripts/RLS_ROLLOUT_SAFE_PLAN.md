# Row Level Security Rollout Plan
## Strategy
- Tables: users, businesses, customers, suppliers, sales, purchases, invoices, payments, bank_transactions, products, stock_movements
- DO NOT apply migrations without explicit approval.
- Start with permissive `true` policies mapped to specific application service roles before isolating to individual user IDs.
