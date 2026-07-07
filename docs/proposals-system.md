# Cult Content — Proposal Generation System

**Owner:** Tommy Lynch / Claude Code  
**Last updated:** July 6, 2026  
**Pipeline context:** Proposals are the primary sales and retention artifact. Most go into the GHL Growth Partner Pipeline → `Proposal Sent` stage (ID: `7e6bf560-11d6-442a-b64f-3bf12f136d5a`).

---

## What proposals are

Single-page HTML files that serve as structured sales/strategy deliverables for prospective or existing brand clients. They live in `/proposals/` in the repo and are served publicly at:

```
https://portal.cultcontent.cc/proposals/{slug}
```

No authentication required. Link is shareable directly to the client (Lenea, Dan, whoever the decision maker is). The server route is in `dashboard-server.js`:

```js
app.get('/proposals/:slug', (req, res) => {
  res.sendFile(path.join(PROPOSALS_DIR, req.params.slug + '.html'))
})
```

There is also a `POST /api/proposals/publish-public` route for programmatic generation, though all existing proposals were hand-built via Claude Code.

---

## Types of proposals

### 1. Sales proposal (new lead)
**When:** A prospect from the GHL Sales Pipeline has had a discovery call and Tommy commits to sending a proposal.  
**Trigger:** Fireflies call transcript + CRM data from GHL opportunity.  
**Purpose:** Win the account. Frames Cult Content's affiliate management service, shows the strategy, presents investment tiers.  
**GHL action:** Move opportunity to `Proposal Sent` stage in Growth Partner Pipeline.

### 2. Retention / strategy pivot proposal (existing client)
**When:** An existing paying client is at churn risk, needs a strategic reset, or has requested a new plan.  
**Trigger:** Fireflies call transcript or client request.  
**Purpose:** Keep the client. Shows real data, addresses what's not working, presents a new plan.  
**GHL action:** None required — client is already in `Active` stage. Proposal is evidence of commitment.  
**Example:** Approved Science (July 2026) — retainer at $1,500/mo unchanged, strategy pivot to brand ambassador program.

### 3. Event / sponsorship proposal
**When:** One-off event partnership or sponsorship opportunity.  
**Example:** Culture Commerce Carnival (July 2026) — sponsorship package for an event.

---

## All current proposals

| File | URL slug | Client | Date | Type | Notes |
|---|---|---|---|---|---|
| `sun-nutrition.html` | `sun-nutrition` | Sun Nutrition | May 29, 2026 | Sales | |
| `magic-scent.html` | `magic-scent` | Magic Scent | Jun 3, 2026 | Sales | |
| `riize.html` | `riize` | Riize | Jun 3, 2026 | Sales | |
| `aquabliss.html` | `aquabliss` | AquaBliss | Jun 11, 2026 | Sales | |
| `approved-science.html` | `approved-science` | Approved Science | Jul 6, 2026 | Retention | Live client, $1,500/mo retainer |
| `culture-commerce-carnival-proposal.html` | n/a (root of repo) | Culture Commerce Carnival | Jul 6, 2026 | Sponsorship | Served differently — not in /proposals/ |

---

## How proposals are generated (process)

### Step 1 — Pull the call transcript
Use Fireflies MCP (`fireflies_get_transcripts`, then `fireflies_get_transcript` by ID). The transcript contains everything discussed on the call — what the client wants, pain points, budget signals, strategy ideas.

### Step 2 — Pull live client data
For TikTok Shop clients: pull Reacher data via the Railway proxy (no auth needed):
```
GET https://cultcontent-server-production.up.railway.app/affiliate/shops
→ find the shop_id for the client

GET https://cultcontent-server-production.up.railway.app/affiliate/shops/{shopId}/creators/top
POST https://cultcontent-server-production.up.railway.app/affiliate/shops/{shopId}/creators
  body: { "days": 30 }
```
This gives: active creator count, GMV, orders, top performers, video volume. Use this to replace any placeholder numbers.

### Step 3 — Check GHL opportunity (for sales proposals)
Pull the contact and opportunity from GHL to know where the prospect is in the pipeline, what their business is, and any notes from prior conversations.

### Step 4 — Build the HTML file
Use the dark design system (see below). Copy the structure from an existing proposal (aquabliss.html is the cleanest reference). Key sections:
1. Top nav with anchor links
2. Hero — brand name, eyebrow tag, h1, sub-copy, meta row (prepared for, brand, product, date)
3. KPI strip — 4 key numbers across the top
4. Numbered sections — typically: Where We Are, The Strategy, The Plan, [Role/Scope specs], Investment, Next Steps
5. Footer with CTA email link

Place the file at: `/Users/tommylynch/cult-command-center/proposals/{client-slug}.html`

### Step 5 — Build the Lark creator tracker (if applicable)
For TikTok Shop clients, pre-populate a Lark Bitable with the top creators from Reacher. App token for the existing Approved Science tracker: `HYbgbsW5AaosQpsa0iSu3uOstZd`. For a new client, create a new app via Lark MCP and link it in the proposal.

### Step 6 — Commit and push
```bash
cd /Users/tommylynch/cult-command-center
git add proposals/{slug}.html
git commit -m "Add {client} proposal"
git push origin main
```
Railway auto-deploys. Proposal is live at `portal.cultcontent.cc/proposals/{slug}` within ~30s.

### Step 7 — Update GHL (for sales proposals)
Move the GHL opportunity to `Proposal Sent` stage and note the URL in the opportunity.

---

## Design system

All proposals use the same dark design system. CSS variables:

```css
--bg: #07070d          /* page background */
--surface: #0e0e18     /* surface elements */
--card: #141420        /* cards */
--border: #1e1e30      /* borders */
--accent: #20d5c4      /* teal — primary accent for numbers, headings, highlights */
--green: #10b981
--yellow: #f59e0b
--red: #ef4444
--blue: #6366f1
--text: #e2e8f0        /* primary text */
--muted: #64748b       /* muted/secondary text */
--light: #94a3b8       /* body copy */
```

Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif`  
Base size: `14px`, line-height `1.65`  
Max content width: `940px` centered  

Key UI patterns:
- **Eyebrow tags:** `background: rgba(32,213,196,.1); border: 1px solid rgba(32,213,196,.22); border-radius: 20px` — used for dates, labels, status
- **KPI strip:** 4-column grid of big numbers, `border: 1px solid var(--border)`, each cell `background: var(--surface)`
- **Cards with left accent border:** `border-left: 3px solid var(--accent)` (or green/yellow/red variants)
- **Callout boxes:** `background: rgba(32,213,196,.06); border: 1px solid rgba(32,213,196,.18); border-radius: 10px`
- **Roadmap/timeline:** 2-column grid (label col + body col), vertical connector line via `::before` pseudo-element
- **Section labels:** `font-size: .62rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--accent)` — always formatted as `01 · Section Name` with `::after` line extending to the right
- **Investment cards:** `border: 1px solid rgba(32,213,196,.25)`, rows of label + value with totals at the bottom

---

## Pipeline Nymph context

Proposals are primarily a **sales tool**. The Pipeline Nymph owns the Growth Partner Pipeline in GHL. When a proposal is built:
- The GHL opportunity should move to `Proposal Sent` stage
- The proposal URL should be noted in the GHL opportunity
- If the prospect goes silent after the proposal, the Pipeline Nymph should follow up via GHL conversation

Retention proposals (like Approved Science) don't touch the GHL pipeline but represent high-priority client relationship work. They should still be tracked — either as a note on the existing GHL contact, or as a separate retention pipeline item.

**GHL Growth Partner Pipeline ID:** `W5PxjulbNVh52Gqlkmzm`  
**Proposal Sent stage ID:** `7e6bf560-11d6-442a-b64f-3bf12f136d5a`

---

## Reacher API quick reference

All calls via Railway proxy (no auth needed from localhost):
```
Base: https://cultcontent-server-production.up.railway.app

GET  /affiliate/shops                                    → all shops + shop_ids
GET  /affiliate/shops/{shopId}/creators/top              → top 10 by GMV
POST /affiliate/shops/{shopId}/creators                  → all creators, body: {"days": 30}
```

Known shop IDs:
- Approved Science: `8913`
