-- Migration 048: Onboarding profile fields
--
-- Additive only, nullable/safe-default columns on the existing `users`
-- table. Reuses the existing `onboarding_done` boolean (added earlier,
-- already wired to /api/onboarding/setup) as the completion gate rather
-- than introducing a duplicate concept — this migration adds
-- `onboarding_completed_at` alongside it purely as a timestamp companion
-- (set together whenever onboarding_done flips to true) so completion
-- time is auditable, without replacing the existing boolean any code
-- already depends on.
--
-- New fields back the 3-stage onboarding (business / priorities / connect):
--   company_website   - stage 1, optional
--   country            - stage 1, required in the UI but nullable here
--                         (safe default), sensibly defaulted client-side
--   role                - stage 1, one of a fixed set of role labels
--   priority_areas      - stage 2, jsonb array of selected priority keys
--   onboarding_completed_at - companion timestamp to onboarding_done

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_website TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS priority_areas JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
