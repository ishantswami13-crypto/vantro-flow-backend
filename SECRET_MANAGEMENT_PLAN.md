# Secret Management Plan

## 1. Overview
This document inventories all secrets used by Vantro Flow, defining where they live, their access policies, and rotation strategies.

## 2. Secret Inventory

### `JWT_SECRET`
- **Purpose**: Signs user authentication tokens.
- **Location**: Backend (`process.env.JWT_SECRET`).
- **Exposure**: Strictly backend-only. Never exposed to frontend.
- **Rotation**: Manual rotation. Rotating logs out all users instantly.
- **Risk**: Critical. If exposed, attackers can forge auth tokens for any user.

### `SUPABASE_SERVICE_ROLE_KEY`
- **Purpose**: Bypasses RLS to perform administrative database operations (e.g., cron jobs, cross-user syncing).
- **Location**: Backend.
- **Exposure**: Strictly backend-only.
- **Risk**: Critical. Full database read/write access.

### `DATABASE_URL`
- **Purpose**: Direct connection to Postgres for advanced pooling or raw SQL.
- **Location**: Backend.
- **Exposure**: Strictly backend-only.

### `RAZORPAY_WEBHOOK_SECRET`
- **Purpose**: Verifies incoming payment events from Razorpay.
- **Location**: Backend.
- **Exposure**: Strictly backend-only.

### `PUBLIC_LINK_SECRET`
- **Purpose**: Signs public bill/invoice links to prevent tampering and ensure expiries.
- **Location**: Backend. Defaults to `JWT_SECRET` if not set.

## 3. Safe Rotation & Rollback
- Wait for `SECRET_ROTATION_PLAYBOOK.md` instructions before rotating any secret.
- **Rollback**: To rollback a secret rotation, you must reinstate the old secret in the environment variables and restart the backend.
