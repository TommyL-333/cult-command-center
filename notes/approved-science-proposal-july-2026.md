# Approved Science — Brand Ambassador Proposal (July 2026)

**Date:** July 6, 2026  
**Client contact:** Lenea Ma (lenea@marketily.com), Dan Markowitz  
**Proposal URL:** https://portal.cultcontent.cc/proposals/approved-science  
**File:** `/proposals/approved-science.html`  
**Reacher shop ID:** 8913  
**Lark creator tracker:** https://cedw5xj2shl.usttp.larksuite.com/base/HYbgbsW5AaosQpsa0iSu3uOstZd  

---

## Context

Approved Science is an **existing paying client** at **$1,500/month**. This proposal is a **retention and strategy pivot**, not a sales proposal. The account is at mild churn risk — the current affiliate model isn't scaling fast enough.

Tommy had a 32-minute call with Lenea Ma on July 6, 2026 (Fireflies transcript ID: `01KWW487HT7P8Z6F7Y3VNJ0JPT`). The call defined the new plan.

**Products:** Appetite Suppressant (primary GMV driver), Collagen, Paris Strand, Shilajit  
**Focus product for next 90 days:** Appetite Suppressant only

---

## The problem (why the proposal exists)

The current open affiliate model isn't scaling:
- 300 creators outreached all time, only 72 active in last 30 days
- $532 GMV / 13 orders in the last 30 days — low for the creator pool size
- Only 8 of 72 active creators generated any revenue (11% conversion)
- Top 2 creators (Jenna + Priscilla) = 45% of all GMV — extreme concentration risk
- Most creators post 1 video then go silent
- Content violations: creators posting supplement content from personal accounts get TikTok health filter strikes, which deters posting

---

## The proposed solution

**Brand Ambassador Challenge** — recruit 2–3 long-term creators at $3,000/month each who post through the Approved Science brand page (not their personal accounts). This eliminates violation risk since the creator's personal account score isn't touched.

Key mechanics:
- **Challenge to find ambassadors:** 4-week structured challenge, minimum 10 videos to qualify for ambassador consideration
- **Ambassador rate:** $3,000/mo for 30 videos ($100/video) + commission on sales
- **Posting model:** Creator produces content, Cult Content reviews it, it posts under Approved Science's TikTok brand page
- **Scale is flexible:** hire however many come out of the challenge worth hiring (1, 2, or 3) — no pre-committed headcount
- **Cult Content retainer stays at $1,500/mo** — no increase; was explicitly part of the call discussion (Lenea/Dan at churn risk, don't push pricing)

---

## What was built

1. **HTML proposal** at `portal.cultcontent.cc/proposals/approved-science` — 11-section dark-mode proposal covering: situation, pivot, challenge mechanics, role spec (ambassador contract terms), 90-day plan, affiliate flywheel, scope of work, investment, operational upgrades, not included, next steps

2. **Lark Bitable creator tracker** pre-populated with top 10 creators from Reacher:
   - Jenna (jenna.alex21) — $158.99 GMV, 4 sales, 18 videos
   - Priscilla (priscillawessonugc) — $79.48 GMV, 2 sales, 31 videos
   - Olivia, Melanie, Autumn, Sandra, Candy, Danielle (borninthe1990s), Ricensalt, Lexrenaud
   - Fields: TikTok Handle, Status (Active/Pending/Ambassador/Inactive), Product, Videos Posted, GMV, Sales, Commission, Contact/Discord, Notes

---

## What's pending

- [ ] **Send proposal to Lenea** — Email or link share the `portal.cultcontent.cc/proposals/approved-science` URL
- [ ] **Dan's approval on ambassador budget** — $3,000/mo per ambassador + ~$500–$750 challenge payout. This is the one decision gate before kickoff
- [ ] **Challenge brief** — Tommy to deliver within 48 hours of Dan's approval (per proposal Next Steps section)
- [ ] **Lenea's booking calendar** — Set up Calendly link and distribute to creators (mentioned in proposal but not yet created)
- [ ] **Community blast** — Proposal describes blasting challenge to Skool groups, TikTok affiliate communities, and Reacher creator pool once brief is approved

---

## Key constraints to remember

- **Retainer stays $1,500/mo** — Do not increase it. Lenea and Dan are at churn risk and this was explicitly stated on the call. If you're building anything that adds cost to Cult Content's management fee, it needs Tommy's sign-off first.
- **Cult Content does NOT pay the ambassadors** — The $3,000/mo per ambassador is funded by Approved Science directly. Cult Content manages the program but the creator cost sits with the client.
- **Brand page posting is non-negotiable** — The entire risk mitigation model depends on content posting under the Approved Science account, not the creator's personal account. Don't design anything that has creators posting from personal accounts.
- **Appetite Suppressant only for 90 days** — Don't dilute the focus across all 4 products. Prove the model on AS first, then expand.

---

## Continuing this work

The next session picking this up should:

1. **Confirm proposal was sent** — If not, send the URL to Lenea at lenea@marketily.com
2. **Track Dan's budget approval** — If no response in 48–72 hours, follow up
3. **Build the challenge brief** once budget is approved — This is a separate document (or section) that covers: the specific content angles for Appetite Suppressant that are violation-safe, the hook formats proven to work, the approved language for health/supplement claims, and the scoring criteria for ambassador selection
4. **Set up Lenea's Calendly** — Booking link to distribute to creators; needs to connect to Lenea's calendar, not Tommy's

To pull fresh Reacher data for this client at any time:
```bash
curl "https://cultcontent-server-production.up.railway.app/affiliate/shops/8913/creators/top"
curl -X POST "https://cultcontent-server-production.up.railway.app/affiliate/shops/8913/creators" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
```

To update the Lark tracker: app token `HYbgbsW5AaosQpsa0iSu3uOstZd`, creators table `tbldr3oMQ3EzHi4h`.
