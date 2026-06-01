# 🛍 TikTok Shop Publisher — Build Spec

Complete technical reference for building a TikTok Shop video scheduler using the **Storista API**. Covers the full pipeline from video upload to scheduled posting, including every quirk and failure mode discovered in production.

---

## Overview

The publisher works in three stages:

1. **Upload** — Video files are uploaded to Storista (S3-backed), creating a `media_id`
2. **Queue** — Jobs are stored in your database with `media_id`, `caption`, `account`, `scheduledFor`
3. **Scheduler** — A background process runs every 60s, picks up due jobs, creates a TikTok video via Storista, publishes it, and polls for completion

Storista acts as the middleware between your app and TikTok's Direct Post API. You never call TikTok's API directly — Storista holds the OAuth connection to TikTok accounts.

---

## Storista API

**Base URL:** `https://api-v2.storista.io`  
**Auth:** `Authorization: Bearer <api_key>` on every request  
**Built with:** FastAPI (Python)

### ⚠️ Critical: GET requests must NOT send Content-Type

Storista is a FastAPI app. If you send `Content-Type: application/json` on a **GET** request, FastAPI tries to parse the request body as JSON, finds nothing, and throws a `JSON Decode Error` — your request fails with a 422 or 500.

**Wrong (causes 422/500 on all GETs):**
```js
axios.create({ headers: { Authorization: 'Bearer ...', 'Content-Type': 'application/json' } })
// This axios instance will break every GET call
```

**Right — use separate clients for GET vs POST:**
```js
// POST client — include Content-Type
const s = axios.create({
  baseURL: 'https://api-v2.storista.io',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  timeout: 30_000,
});

// GET helper — NO Content-Type header
const sGet = (path) => axios.get(`https://api-v2.storista.io${path}`, {
  headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  timeout: 15_000,
});
```

---

## Step 1 — Upload a Video

### File size limit

**Max: 200 MB.** Files over 200 MB get a `{"detail": "File too large (max 200 MB)"}` error at the pre-sign step — before you waste time uploading to S3. Compress first.

```bash
# macOS built-in (avconvert) — no ffmpeg required
avconvert -s input.mp4 -o output_compressed.mp4 -p Preset640x480 --replace --progress

# ffmpeg (if available) — better quality control
ffmpeg -i input.mp4 -vcodec libx264 -crf 23 -preset medium -acodec aac -b:a 128k output.mp4
```

### Upload flow (3 steps)

```
1. POST /v1/media/pre-sign   → get upload_url (S3 presigned URL) + upload_id
2. PUT  <upload_url>         → upload raw bytes directly to S3
3. POST /v1/media/           → create media record, get back media_id
```

#### Step 1 — Pre-sign
```js
const { data: presign } = await s.post('/v1/media/pre-sign', {
  filename:     'my-video.mp4',
  content_type: 'video/mp4',
  size:         statSync(filePath).size,  // bytes
});

const upload_id  = presign.upload_id || presign.id || presign.key;
const upload_url = presign.upload_url || presign.url || presign.presigned_url;
// ↑ field name varies — check all three aliases
```

#### Step 2 — S3 PUT
```js
const buffer = readFileSync(filePath);
await axios.put(upload_url, buffer, {
  headers: {
    'Content-Type':            'video/mp4',
    'Content-Length':          buffer.length,
    'x-amz-content-sha256':    'UNSIGNED-PAYLOAD',  // required by the S3 policy
  },
  maxBodyLength:   Infinity,  // axios will otherwise reject large buffers
  maxContentLength: Infinity,
  timeout:         300_000,   // 5 min — large files can be slow
});
```

#### Step 3 — Create media record
```js
const { data: media } = await s.post('/v1/media/', {
  upload_id,
  name: 'my-video.mp4',
});

const mediaId = media.id;  // integer — store this
```

---

## Step 2 — The Queue

Store jobs in your database (or a JSON file). Each job:

```ts
interface PublishJob {
  id:           string;   // UUID — your internal ID
  filename:     string;   // human label
  mediaId:      string;   // Storista media ID (store as string, cast to int at publish time)
  caption:      string;   // TikTok caption with hashtags
  productId:    string;   // TikTok Shop product ID (optional — omit if not a shop post)
  account:      string;   // TikTok handle, e.g. "trustedrituals"
  status:       'scheduled' | 'processing' | 'published' | 'failed';
  scheduledFor: string;   // ISO 8601 UTC
  retries:      number;
  tiktokVideoId?: number; // set once created in Storista; used to avoid duplicate posts
  publishedAt?:  string;
  error?:        string;
}
```

### ⚠️ API key scope

**Each Storista API key is scoped to a single Storista account.** If you upload a video with Key A, you CANNOT publish it using Key B — the media ID will return 404.

If your app supports multiple brands each with their own Storista API key:
- Always upload using the **same key** that the scheduler will use to publish
- Never use a global/fallback key for uploads if individual brands have their own keys

---

## Step 3 — The Scheduler

Run on a 60-second interval. On each tick:

1. Load jobs where `status = 'scheduled'` AND `scheduledFor <= now`
2. For each due job: create TikTok video → publish → save as `processing` immediately → poll for READY

### Full scheduler (Node.js/Express)

```js
setInterval(async () => {
  const now = Date.now();
  const jobs = await db.getJobsDue(now);  // status='scheduled', scheduledFor <= now

  for (const job of jobs) {
    try {
      const apiKey = await db.getBrandApiKey(job.brandId);
      const s = axios.create({
        baseURL: 'https://api-v2.storista.io',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      });
      const sGet = (path) => axios.get(`https://api-v2.storista.io${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        timeout: 15_000,
      });

      // 1. Verify media is accessible
      await sGet(`/v1/media/${job.mediaId}`);  // throws 404 if not found

      // 2. Create TikTok video object
      const { data: created } = await s.post(
        `/v1/tiktok/accounts/${job.account}/videos`,
        {
          video_id:     parseInt(job.mediaId, 10),  // ← MUST be integer, not string
          caption:      job.caption || '',
          product_id:   job.productId || '',
          product_link: 'SHOP NOW',                 // ← required CTA; max 20 chars
        }
      );
      const vid_id = created.id || created.video_id;

      // 3. Publish
      await s.post(
        `/v1/tiktok/accounts/${job.account}/videos/${vid_id}/publish`,
        {}                                          // ← MUST pass empty object, NOT omit body
      );

      // ── CRITICAL: save as 'processing' BEFORE the polling loop ──────────────
      // The polling loop takes ~60s (12 polls × 5s). The next scheduler tick
      // fires at the same interval. If you don't save here, the next tick reads
      // status='scheduled' and submits a DUPLICATE video to TikTok.
      await db.updateJob(job.id, { status: 'processing', tiktokVideoId: vid_id });

      // 4. Poll for READY status (TikTok processes after publish — takes 30-120s)
      let ready = false;
      for (let poll = 0; poll < 12; poll++) {
        await sleep(5000);
        try {
          const { data: statusCheck } = await sGet(
            `/v1/tiktok/accounts/${job.account}/videos/${vid_id}`
          );
          if (statusCheck.status === 'READY' || statusCheck.status === 'PUBLISHED') {
            ready = true;
            break;
          }
          if (statusCheck.reject_reason) {
            throw new Error(`Rejected: ${statusCheck.reject_reason} — ${statusCheck.status_text}`);
          }
        } catch (pollErr) {
          if (pollErr.message?.startsWith('Rejected:')) throw pollErr;
          // transient error during poll — continue
        }
      }

      // 5. Final status
      await db.updateJob(job.id, {
        status:      ready ? 'published' : 'processing',
        publishedAt: new Date().toISOString(),
        tiktokVideoId: vid_id,
      });

    } catch (e) {
      const errMsg = e.response?.data?.detail
        ? String(e.response.data.detail)
        : e.message;

      // "Video not found" = Storista media still processing — retry
      const isNotReady = /not found/i.test(errMsg);
      const retries = (job.retries || 0) + 1;

      if (isNotReady && retries < 15) {
        await db.updateJob(job.id, { retries });  // keep status='scheduled', retry next tick
      } else {
        await db.updateJob(job.id, { status: 'failed', error: errMsg, retries });
      }
    }
  }
}, 60_000);
```

---

## Critical Quirks & Fixes

### 1. Race condition — duplicate TikTok posts

**The bug:** The polling loop takes 60s (12 × 5s). The scheduler interval is also 60s. If you don't persist the job as `processing` before polling, the next tick fires, reads `status='scheduled'`, and submits a second video. You get two identical posts.

**The fix:** Save `status='processing'` + `tiktokVideoId` to the database **immediately after publish**, before entering the polling loop.

```js
// ← do this FIRST, before any polling
await db.updateJob(job.id, { status: 'processing', tiktokVideoId: vid_id });

// ← THEN poll
for (let poll = 0; poll < 12; poll++) { ... }
```

---

### 2. Server restart recovery — stuck processing jobs

**The bug:** If your server restarts while a job is mid-poll, the job stays as `processing` forever. It won't be picked up by the scheduler (which filters for `status='scheduled'` only).

**The fix:** On server startup, inspect all `processing` jobs:

```js
// On startup — run this before the scheduler interval starts
const stuckJobs = await db.getJobsByStatus('processing');
for (const job of stuckJobs) {
  if (!job.tiktokVideoId) {
    // Never submitted to TikTok — safe to reset and retry
    await db.updateJob(job.id, { status: 'scheduled' });
  }
  // If job HAS a tiktokVideoId, it was submitted to TikTok.
  // Leave it as 'processing'. You can optionally poll its current status here.
  // DO NOT reset it to 'scheduled' — you'll get a duplicate post.
}
```

**The distinction is critical:**
- `processing` + no `tiktokVideoId` = server died before TikTok submission → safe to retry
- `processing` + has `tiktokVideoId` = video was submitted → do NOT resubmit

---

### 3. Empty body required on publish

```js
// ❌ Wrong — FastAPI will reject with 422
await axios.post(`/v1/tiktok/accounts/${account}/videos/${vid_id}/publish`);

// ✅ Correct — pass empty object
await axios.post(`/v1/tiktok/accounts/${account}/videos/${vid_id}/publish`, {});
```

---

### 4. `video_id` must be an integer

```js
// ❌ Wrong — Storista rejects string
{ video_id: '432005' }

// ✅ Correct
{ video_id: parseInt(mediaId, 10) }
```

If your media IDs are stored as strings (recommended for safety with large IDs), always cast at call time.

---

### 5. `product_link` is required and has a max length

The `product_link` field is the CTA button label. It's required for TikTok Shop posts and **must be ≤ 20 characters**.

```js
{ product_link: 'SHOP NOW' }   // ✅ 8 chars
{ product_link: 'BUY NOW' }    // ✅ 7 chars
// Don't use a URL here — it's a label, not a link
```

---

### 6. Media 404 during publish = Storista still processing

When you upload a video, Storista doesn't make it instantly available. There's a processing window (varies with file size). If the scheduler picks up the job while Storista is still processing the media, the `/v1/media/{id}` GET returns 404.

**Handle with a retry loop** (not an immediate failure):

```js
} catch (e) {
  const isNotReady = /not found/i.test(e.response?.data?.detail || '');
  if (isNotReady && job.retries < 15) {
    // keep status='scheduled' — will retry on next tick
    await db.updateJob(job.id, { retries: job.retries + 1 });
  } else {
    await db.updateJob(job.id, { status: 'failed', error: errMsg });
  }
}
```

Large files (150-200MB) can take 3-5 minutes to process. With a 60s tick interval, you have 15 retries = 15 minutes of patience.

---

### 7. TikTok PROCESSING status is normal — don't panic

After publishing, Storista returns `status: PROCESSING`. This is TikTok's video encoding pipeline — it's not an error. It typically takes 30–120 seconds. Your 12-poll window (60s) will often expire before TikTok finishes.

When this happens, mark the job `processing` in your DB. The video WILL be live on TikTok — you just didn't catch the READY confirmation.

**Possible statuses from Storista's TikTok video endpoint:**
| Status | Meaning |
|--------|---------|
| `PROCESSING` | TikTok is encoding — normal, wait longer |
| `READY` | Published and live on TikTok ✅ |
| `PUBLISHED` | Alternative "live" status — treat same as READY ✅ |
| `NEW` | Created but not yet published |
| `REJECTED` | TikTok policy violation — check `reject_reason` field |
| `FAILED` | TikTok-side encoding failure |

---

### 8. API key scoping — wrong key = 404 on all media

Each Storista account (API key) has its own isolated media library. If you upload with Key A and try to publish with Key B, every `/v1/media/{id}` request returns 404.

**Common failure mode:** You have a global fallback API key in your env vars. You use it to batch-upload videos. But the brand's scheduler uses their own key stored in the DB. Result: all 27 uploads are invisible to the scheduler.

**Prevention:**
- Always fetch the brand's specific API key before uploading
- Verify the upload succeeded by immediately calling `GET /v1/media/{id}` with the SAME key
- Optionally, expose a debug endpoint that shows the first 8 chars of both keys so you can confirm they match

---

## Storista API Endpoint Reference

```
POST   /v1/media/pre-sign                                    → get S3 presigned upload URL
PUT    <presigned_url>                                        → upload to S3 directly
POST   /v1/media/                                            → create media record
GET    /v1/media/                                            → list all media (no Content-Type header!)
GET    /v1/media/{id}                                        → get single media item
GET    /v1/tiktok/accounts/{handle}/videos                   → list TikTok videos for account
POST   /v1/tiktok/accounts/{handle}/videos                   → create TikTok video object
POST   /v1/tiktok/accounts/{handle}/videos/{vid_id}/publish  → publish to TikTok
GET    /v1/tiktok/accounts/{handle}/videos/{vid_id}          → get video status
```

---

## Job Status Flow

```
[scheduled] → scheduler picks up → creates TikTok video → publishes
                                                         ↓
                                              [processing] ← saved IMMEDIATELY before polling
                                                         ↓
                                        TikTok encodes (30-120s)
                                                         ↓
                                              READY confirmed? 
                                               ↓           ↓
                                         [published]   [processing]  ← polling timed out but video IS live
                                                                          check status manually or ignore
                         
                   upload errored? → retry up to 15 ticks → [failed]
```

---

## Batch Upload Script Pattern

When uploading many videos at once (e.g. 29 videos for a brand):

```js
const START_MS = Date.now() + 5 * 60 * 1000;   // start 5 min from now
const GAP_MS   = 30 * 60 * 1000;               // 30 min between each post

for (let i = 0; i < videos.length; i++) {
  const mediaId     = await uploadVideo(videos[i].path, apiKey);
  const scheduledFor = new Date(START_MS + i * GAP_MS).toISOString();

  await db.createJob({
    id:           randomUUID(),
    mediaId:      String(mediaId),
    caption:      videos[i].caption,
    account:      tiktokHandle,
    productId:    shopProductId,
    status:       'scheduled',
    scheduledFor,
    retries:      0,
  });
}
```

**File size**: Check and compress any files > 200MB **before** calling pre-sign. The API rejects at pre-sign (before the S3 upload), so you find out immediately — but it means that video gets skipped unless you handle it.

---

## Environment Variables

```bash
STORISTA_API_KEY=       # global/fallback key — use brand-specific keys when available
```

---

## Queue Database Schema (SQL)

```sql
CREATE TABLE publish_jobs (
  id              TEXT PRIMARY KEY,
  brand_id        TEXT NOT NULL,
  filename        TEXT,
  media_id        TEXT NOT NULL,       -- Storista media ID; store as TEXT
  caption         TEXT,
  product_id      TEXT,
  tiktok_account  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled',
                  -- CHECK (status IN ('scheduled','processing','published','failed'))
  scheduled_for   TIMESTAMPTZ NOT NULL,
  retries         INT NOT NULL DEFAULT 0,
  tiktok_video_id INT,                 -- null until submitted; presence = "already sent to TikTok"
  published_at    TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_publish_jobs_due 
  ON publish_jobs (brand_id, status, scheduled_for) 
  WHERE status = 'scheduled';
```

---

## What Goes Wrong — Summary Table

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| `JSON Decode Error` on GET requests | Axios instance has `Content-Type: application/json` set globally | Use separate GET helper without Content-Type |
| Publish returns 422 | Empty body not passed to publish endpoint | `s.post('/publish', {})` — pass `{}` not nothing |
| Media 404 when publishing | Uploaded with Key A, publishing with Key B | Use brand-specific key for both upload and publish |
| Media 404 on first few retries, then works | Storista still processing the video | Retry up to 15 times with 60s gaps |
| `video_id` validation error | Sending media ID as string | `parseInt(mediaId, 10)` |
| `product_link` too long | CTA string > 20 chars | Use `'SHOP NOW'` or similar short string |
| Duplicate TikTok posts | Race condition: polling loop = tick interval | Save `status='processing'` + `tiktokVideoId` before polling loop |
| Jobs stuck as `processing` forever after restart | Server died mid-poll | On startup: reset `processing` jobs with no `tiktokVideoId` back to `scheduled` |
| Videos appear twice on TikTok | Startup recovery reset a submitted job | Only reset if `tiktokVideoId` is null |
| 200MB file rejected at pre-sign | Storista file size limit | Compress before upload; check file size before calling API |

---

*Built for the Cult Content Command Center — May 2026*
