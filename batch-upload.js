#!/usr/bin/env node
/**
 * Trusted Rituals — batch Storista uploader
 * Usage: railway run node batch-upload.js
 *
 * Uploads 29 videos to Storista, creates media records,
 * then injects scheduled queue jobs into the live server.
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');

// ── Config ─────────────────────────────────────────────────────────────────
// STORISTA_KEY: auto-fetched from server (brand-specific key) or falls back to env var
let STORISTA_KEY     = process.env.STORISTA_API_KEY || '';
const STORISTA_BASE  = 'https://api-v2.storista.io';
// Use Railway direct URL (bypasses Cloudflare Access)
const DASHBOARD_URL  = process.env.DASHBOARD_DIRECT_URL || 'https://cult-command-center-production.up.railway.app';
const ADMIN_SECRET   = process.env.ADMIN_BATCH_SECRET || 'cult-batch-2026';
const BRAND_ID       = process.env.TRUSTED_RITUALS_BRAND_ID || 'trusted-rituals'; // override if needed
const TIKTOK_ACCOUNT = 'trustedrituals';
const PRODUCT_ID     = '1732230831415267648';
const VIDEO_DIR      = '/Users/tommylynch/Downloads/OneDrive_1_5-28-2026';

// ── Caption map (video filename → caption) ─────────────────────────────────
const CAPTIONS = {
  '3 THINGS FINAL.mp4':
    `Your throat goes through more than you think. City air, constant calls, AC, late nights - it all adds up.\nThat's why we made Mullein Honey Sticks, a simple on-the-go ritual designed for everyday throat wellness.\nEasy to carry. Easy to take. Easy on your throat.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'BACK TO BACK CALLS FINAL UPLAOD.mp4':
    `If you talk for a living, your throat probably feels it.\nSales calls, teaching, meetings, presentations.. constant talking can dry out your throat fast.\nThat's why we made Mullein Honey Sticks\nEasy, on-the-go throat support for busy days.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf #teachersoftiktok #saleslife`,

  'CITY FINAL.mp4':
    `We take supplements for our skin, gut, protein intake, energy — but almost nobody thinks about their lungs.\nMeanwhile, city air, dust, pollution, and smoke are part of daily life.\nThat's why we made Mullein Honey Sticks\nSimple daily support for your throat & lungs, wherever you go.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'CLEAR YOUR THROAT FINAL UPLOAD.mp4':
    `If you wake up clearing your throat every morning… that's not as normal as you think\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'COMMENT FINAL UPLOAD.mp4':
    `Most Mullein products taste grassy & bitter… so we made one that actually tastes GOOD\nGinger lemon + pure honey with a smooth herbal finish.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'DOUBLING FINAL UPLOAD.mp4':
    `Mullein isn't a "take once when sick" kind of thing\nThe real difference comes from taking it daily, before the bad days hit.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'FINAL TAX.mp4':
    `That random scratchy throat by 3PM? I thought it was just part of city life too #citylife #mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'FOUNDER VIDEO_1.mp4':
    `Wellness only works if you can stay consistent with it.\nThat's why we build products that are functional, convenient & actually enjoyable to take.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'HOT TAKE FINAL IT IS.mp4':
    `Most supplements don't fail because they don't work. You just aren't able to stay consistent long enough.\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'If your throat feel like sandpaper.mp4':
    `Your lungs deal with dust, pollen & pollution every single day.\nMaybe it's time we supported them too\n#mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'is it safe.mp4':
    `No stimulants. No complicated formulas. Just Mullein, pure honey & a daily ritual\n#dailyritual #mullein #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'LUNG ORGAN FINAL UPLOAD.mp4':
    `We take supplements for almost everything… except the organs we use every second of the day.\nOne Mullein Honey Stick every morning\n#mullein #lunghealth #dailyritual #mulleinhoney #throatcare #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'MORNING SCRATCHY THROAT FINAL UPLOAD.mp4':
    `That constant "need to clear your throat" feeling every morning? This became my go-to before coffee\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'Mullein Leaf Tea FINAL upload 1.mp4':
    `Most wellness products fail because they're hard to stay consistent with.\n10 seconds every morning changed that for me\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'MULLEIN LISTING VIDEO.mp4':
    `Meet the herb behind the ritual\nSourced with intention. Made for everyday respiratory wellness.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'NOT A 2024 TREND FINAL UPLOAD.mp4':
    `Mullein isn't some random wellness trend. Centuries of use, now in a 10-second daily ritual\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'FINAL UPLOAD THROAT.mp4':
    `No fillers. No hidden ingredients. Just mullein leaf, pure honey & ingredients that actually make sense.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'PEOPLE KEEP ASKING 1.mp4':
    `Only mullein leaves. Pure honey. Nothing unnecessary. We kept the formula simple on purpose.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'SMOKINH MULLEIN.mp4':
    `Can you smoke mullein? Technically yes… but should you? No.\nFor real lung & throat support, it's about daily, consistent use, not smoke.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'SUPPLEMENT INDUSTRY FINAL.mp4':
    `The supplement industry has a consistency problem.\nIf you don't take it daily, it doesn't matter how "good" it is!!\n#mullein #founderbrand #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'SUPPLEMENT ROUTINE FINAL UPLOAD.mp4':
    `Most supplement routines are way too complicated. We built Mullein Honey Sticks for the opposite reason — 10 seconds. One stick. Done.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'VAPE OR SMOKE.mp4':
    `Even occasional smoking or vaping puts stress on your lungs and throat.\nA simple daily ritual to support your airway wellness.\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf #vapers #smokers #smoke #cigarettes`,

  'WATER FINAL UPLOAD.mp4':
    `Drinking more water isn't always enough for a scratchy throat. Sometimes your throat needs actual support. Try out Mullein Honeysticks today!!\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'welness habit FINAL UPLOAD.mp4':
    `The best wellness routine is the one you'll actually stick to.\n10 seconds a day. No prep. No complicated routine!!\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'WHEN MY FRIENDS ASK ME 1.mp4':
    `Don't wait for your lungs to "feel bad" before supporting them.\nSmall daily rituals > complicated routines.\nOur honey sticks make your daily rituals convenient!!\n#mullein #throatcare #morningroutine #dailyritual #mulleinhoney #wellness #founderstory #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'WHY DID WE PUT HONEY DRAFT 1.mp4':
    `People kept asking us - why honey instead of capsules?\nBecause mullein is meant for your throat & airways, and honey helps it actually coat where it matters.\nJust 2 simple ingredients, working together the way they're supposed to\n#Mullein #FounderStory #WellnessRoutine #LungHealth #TrustedRituals #morningroutine #dailyritual #mulleinhoney #throatcare #wellness #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'WHY MULLEIN.mp4':
    `So many people asked us - why Mullein?\nBecause it's an ancient ingredient people have used for throat & lung support for ages, but the formats never felt easy to use consistently.\nThat's why we made raw mullein + pure honey in a simple 10-second stick\n#Mullein #FounderStory #WellnessRoutine #LungHealth #TrustedRituals #morningroutine #dailyritual #mulleinhoney #throatcare #wellness #dailywellness #honeysticks #herbalwellness #mulleinleaf`,

  'WREAKING YOUR THROAT.mp4':
    `Your throat goes through more in a day than you realize 💨\nAC. Calls. Pollution. Mouth breathing while sleeping. And then we wonder why our throat feels "off" all the time…\n10 seconds a day is all I changed!\n#Mullein #ThroatCare #WellnessHabits #BreathingSupport #DailyRoutine`,

  'ZOOM CALL FINAL.mp4':
    `POV: You stopped thinking constant throat clearing was "just normal"\n2 weeks. 10 seconds every morning. Now my throat feels clearer & I'm not that person anymore.\n#Mullein #WellnessRoutine #BreathingBetter #BeyondHoney #TikTokMadeMeTryIt`,
};

// ── Upload helpers ─────────────────────────────────────────────────────────
// Build Storista axios instance (called after STORISTA_KEY is resolved)
function makeStoristaClient() {
  return axios.create({
    baseURL: STORISTA_BASE,
    headers: { Authorization: `Bearer ${STORISTA_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
}
let s = null; // initialized after key is resolved

async function uploadVideo(filePath, filename) {
  if (!s) s = makeStoristaClient();
  const stat = fs.statSync(filePath);
  console.log(`  pre-signing ${filename} (${Math.round(stat.size / 1024 / 1024)}MB)...`);

  const { data: presign } = await s.post('/v1/media/pre-sign', {
    filename, content_type: 'video/mp4', size: stat.size,
  });
  const upload_id  = presign.upload_id || presign.id || presign.key;
  const upload_url = presign.upload_url || presign.url || presign.presigned_url;
  if (!upload_url) throw new Error(`No upload_url: ${JSON.stringify(presign)}`);

  console.log(`  uploading to S3...`);
  const buf = fs.readFileSync(filePath);
  await axios.put(upload_url, buf, {
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300_000,
  });

  console.log(`  creating media record...`);
  const { data: media } = await s.post('/v1/media/', { upload_id, name: filename });
  console.log(`  ✓ media id=${media.id}`);
  return media.id;
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  // Resolve brand ID AND brand-specific Storista key from server
  console.log('Fetching brand config from dashboard...');
  let brandId = BRAND_ID;
  try {
    const r = await axios.get(`${DASHBOARD_URL}/api/admin/brands-list`, {
      headers: { 'x-admin-secret': ADMIN_SECRET }, timeout: 10_000,
    });
    const tr = (r.data.brands || []).find(b => b.name?.toLowerCase().includes('trusted'));
    if (tr) { brandId = tr.id; console.log(`Brand ID: ${brandId}`); }
  } catch(e) { console.log('Could not fetch brand list, using default:', brandId); }

  // Fetch brand-specific Storista key (so we upload to the right account)
  try {
    const r = await axios.get(`${DASHBOARD_URL}/api/admin/brand-debug/${brandId}`, {
      headers: { 'x-admin-secret': ADMIN_SECRET }, timeout: 10_000,
    });
    if (r.data.storistaApiKey) {
      STORISTA_KEY = r.data.storistaApiKey;
      console.log(`Using brand Storista key: ${STORISTA_KEY.slice(0, 8)}... (keysMatch=${r.data.keysMatch})`);
    } else {
      console.warn('Brand has no storistaApiKey — falling back to global key');
    }
  } catch(e) { console.log('Could not fetch brand key, using env key:', e.message); }

  if (!STORISTA_KEY) { console.error('STORISTA_API_KEY not set and brand key not found'); process.exit(1); }
  s = makeStoristaClient();

  const files = Object.keys(CAPTIONS);
  const jobs  = [];

  // Space videos 30 mins apart starting 5 mins from now
  const START_MS = Date.now() + 5 * 60 * 1000;
  const GAP_MS   = 30 * 60 * 1000; // 30 min between posts

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filePath = path.join(VIDEO_DIR, filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  File not found, skipping: ${filename}`);
      continue;
    }

    console.log(`\n[${i + 1}/${files.length}] ${filename}`);
    try {
      const mediaId = await uploadVideo(filePath, filename);
      const scheduledFor = new Date(START_MS + i * GAP_MS).toISOString();
      jobs.push({
        id:           crypto.randomUUID(),
        filename,
        mediaId:      String(mediaId),
        caption:      CAPTIONS[filename],
        productId:    PRODUCT_ID,
        account:      TIKTOK_ACCOUNT,
        status:       'scheduled',
        scheduledFor,
        retries:      0,
        createdAt:    new Date().toISOString(),
      });
      console.log(`  scheduled for ${scheduledFor}`);
    } catch (e) {
      console.error(`  ✗ FAILED: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    }
  }

  if (!jobs.length) { console.error('No jobs to inject'); process.exit(1); }

  // Save jobs to file as backup
  fs.writeFileSync('batch-jobs.json', JSON.stringify(jobs, null, 2));
  console.log(`\nSaved ${jobs.length} jobs to batch-jobs.json`);

  // Inject into server
  console.log(`\nInjecting ${jobs.length} jobs into server (brand: ${brandId})...`);
  try {
    const r = await axios.post(`${DASHBOARD_URL}/api/admin/storista/batch-inject`, {
      brandId, jobs,
    }, {
      headers: { 'x-admin-secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    console.log('✅ Done:', r.data);
  } catch (e) {
    console.error('Inject failed:', e.response?.data || e.message);
    console.log('Jobs saved to batch-jobs.json — inject manually');
  }
})();
