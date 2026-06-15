/**
 * Inner Circle SQLite database
 * Lives at /data/inner_circle.db on the Railway volume
 * No separate service needed — uses existing cult-command-center volume
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'inner_circle.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS inner_circle_creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_handle TEXT NOT NULL,
    creator_name TEXT,
    email TEXT,
    tiktok_user_id TEXT,
    status TEXT DEFAULT 'active', -- active | paused | removed
    cohort_start DATE,
    cohort_end DATE,
    videos_goal INTEGER DEFAULT 20,
    commission_rate REAL DEFAULT 0.50,
    ads_commission_rate REAL DEFAULT 0.25,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inner_circle_brand_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER REFERENCES inner_circle_creators(id),
    shop_id INTEGER NOT NULL,
    shop_name TEXT NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS inner_circle_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER REFERENCES inner_circle_creators(id),
    shop_id INTEGER NOT NULL,
    tiktok_video_id TEXT,
    tiktok_url TEXT,
    views INTEGER DEFAULT 0,
    gmv REAL DEFAULT 0,
    posted_at DATETIME,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inner_circle_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    scheduled_at DATETIME NOT NULL,
    lark_meeting_url TEXT,
    recording_url TEXT,
    attended_creator_ids TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_videos_creator ON inner_circle_videos(creator_id);
  CREATE INDEX IF NOT EXISTS idx_videos_shop ON inner_circle_videos(shop_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_creator ON inner_circle_brand_assignments(creator_id);

  -- ── Creator retainer marketplace ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS creator_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER REFERENCES inner_circle_creators(id),
    per_video_cents INTEGER,
    retainer_monthly_cents INTEGER,
    package_label TEXT,
    package_videos INTEGER,
    package_price_cents INTEGER,
    available INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(creator_id)
  );

  CREATE TABLE IF NOT EXISTS retainer_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER,
    brand_name TEXT,
    creator_id INTEGER REFERENCES inner_circle_creators(id),
    offer_type TEXT,
    amount_cents INTEGER,
    videos INTEGER,
    terms TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS retainer_agreements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER REFERENCES retainer_offers(id),
    brand_id INTEGER,
    creator_id INTEGER REFERENCES inner_circle_creators(id),
    amount_cents INTEGER,
    videos_committed INTEGER,
    videos_delivered INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_retainer_offers_creator ON retainer_offers(creator_id);
  CREATE INDEX IF NOT EXISTS idx_retainer_offers_brand ON retainer_offers(brand_id);
  CREATE INDEX IF NOT EXISTS idx_retainer_agreements_creator ON retainer_agreements(creator_id);
`);

// ── Query helpers ─────────────────────────────────────────────────────────────

const queries = {
  // Creators
  getAllCreators: db.prepare(`SELECT c.*, GROUP_CONCAT(a.shop_name) as brands
    FROM inner_circle_creators c
    LEFT JOIN inner_circle_brand_assignments a ON a.creator_id = c.id AND a.active = 1
    WHERE c.status = 'active'
    GROUP BY c.id ORDER BY c.creator_name`),

  getCreator: db.prepare(`SELECT * FROM inner_circle_creators WHERE id = ?`),

  getCreatorByHandle: db.prepare(`SELECT * FROM inner_circle_creators WHERE creator_handle = ?`),

  insertCreator: db.prepare(`INSERT INTO inner_circle_creators
    (creator_handle, creator_name, email, tiktok_user_id, cohort_start, cohort_end, videos_goal)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),

  // Video counts per creator per month
  getVideoCountThisMonth: db.prepare(`SELECT creator_id, shop_id, COUNT(*) as count
    FROM inner_circle_videos
    WHERE strftime('%Y-%m', posted_at) = strftime('%Y-%m', 'now')
    AND creator_id = ? GROUP BY creator_id, shop_id`),

  insertVideo: db.prepare(`INSERT INTO inner_circle_videos
    (creator_id, shop_id, tiktok_video_id, tiktok_url, views, gmv, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),

  // Calls
  getUpcomingCalls: db.prepare(`SELECT * FROM inner_circle_calls
    WHERE scheduled_at > datetime('now') ORDER BY scheduled_at ASC LIMIT 5`),

  insertCall: db.prepare(`INSERT INTO inner_circle_calls
    (title, scheduled_at, lark_meeting_url) VALUES (?, ?, ?)`),

  // Brand assignments
  assignCreatorToBrand: db.prepare(`INSERT OR REPLACE INTO inner_circle_brand_assignments
    (creator_id, shop_id, shop_name) VALUES (?, ?, ?)`),

  getCreatorBrands: db.prepare(`SELECT * FROM inner_circle_brand_assignments
    WHERE creator_id = ? AND active = 1`),
};

module.exports = { db, queries };
