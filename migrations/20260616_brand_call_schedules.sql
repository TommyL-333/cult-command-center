-- Migration: brand_call_schedules
-- Created: 2026-06-16
-- Purpose: Per-brand weekly creator call schedule. Drives automated SMS reminders
--          and recording association for the Inner Circle weekly call cadence.
--
-- NOTE: This project uses better-sqlite3 (NOT Postgres). DDL is SQLite-compatible:
--   - INTEGER PRIMARY KEY AUTOINCREMENT  (instead of SERIAL)
--   - INTEGER booleans (1/0)             (instead of BOOLEAN)
--   - DATETIME DEFAULT CURRENT_TIMESTAMP (instead of timestamptz now())
-- Apply with: node run-migration.js migrations/20260616_brand_call_schedules.sql

CREATE TABLE IF NOT EXISTS brand_call_schedules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         INTEGER,                                  -- TikTok Shop shop_id (nullable until brand connected)
  brand_id        TEXT,                                     -- brands.json client id (e.g. 'mp3662rlaczd')
  brand_name      TEXT NOT NULL,
  call_day        TEXT,                                     -- 'monday' | 'tuesday' | ... | 'friday' (NULL = TBD)
  call_time       TEXT,                                     -- 'HH:MM' 24h local, e.g. '12:00' (NULL = TBD)
  timezone        TEXT    NOT NULL DEFAULT 'America/New_York',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  meeting_url     TEXT,
  active          INTEGER NOT NULL DEFAULT 1,               -- 1 = true, 0 = false
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brand_call_schedules_shop ON brand_call_schedules(shop_id);
CREATE INDEX IF NOT EXISTS idx_brand_call_schedules_active ON brand_call_schedules(active);

-- ── Seed: three confirmed brands ─────────────────────────────────────────────
-- Idempotent: only insert a brand_name if it does not already exist.

-- 1) Approved Science — Tuesday 12:00 ET, 30 min (CONFIRMED)
INSERT INTO brand_call_schedules (shop_id, brand_id, brand_name, call_day, call_time, timezone, duration_minutes, active)
SELECT 8913, 'mp3662rlaczd', 'Approved Science', 'tuesday', '12:00', 'America/New_York', 30, 1
WHERE NOT EXISTS (SELECT 1 FROM brand_call_schedules WHERE brand_name = 'Approved Science');

-- 2) Yuglo — day/time TBD, inactive until scheduled (shop_id 10021 per Reacher map)
INSERT INTO brand_call_schedules (shop_id, brand_id, brand_name, call_day, call_time, timezone, duration_minutes, active)
SELECT 10021, NULL, 'Yuglo', NULL, NULL, 'America/New_York', 30, 0
WHERE NOT EXISTS (SELECT 1 FROM brand_call_schedules WHERE brand_name = 'Yuglo');

-- 3) Katia's brand — Friday (time TBD), inactive until time + shop_id confirmed
INSERT INTO brand_call_schedules (shop_id, brand_id, brand_name, call_day, call_time, timezone, duration_minutes, active)
SELECT NULL, NULL, 'Katia''s Brand', 'friday', NULL, 'America/New_York', 30, 0
WHERE NOT EXISTS (SELECT 1 FROM brand_call_schedules WHERE brand_name = 'Katia''s Brand');
