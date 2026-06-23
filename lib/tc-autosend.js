'use strict';

/**
 * tc-autosend.js — pure helpers for auto-sending Target Collabs on creator registration.
 *
 * resolveBrandTcContext(brandId): pure, no network. Loads brands.json (the
 * cult-command-center client roster) and resolves the brand by id, referralCode,
 * or name (slug-tolerant, case-insensitive). Returns the minimal context the
 * TC-autosend relay needs, or { found: false } if no brand matches.
 *
 * Schema notes (verified against real brands.json):
 *   - top-level key is `clients` (not `brands`)
 *   - each client: { id, name, referralCode?, shopId?, commissionRate?, gmvShare?, openCollabEnabled }
 *   - referralCode is NOT present on every client -> must also match id/name
 *   - shopId is missing on not-yet-onboarded brands (e.g. Alpha Flow)
 *   - there is NO structured product-name field; we surface the brand `name`
 *     as the TC product label rather than fabricating a SKU.
 *   - tcPercent: prefer commissionRate*100, else gmvShare, else null.
 */

const fs = require('fs');
const path = require('path');

// Normalize a string into a comparable slug: lowercase, strip non-alphanumerics.
function slugify(v) {
  if (v === undefined || v === null) return '';
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Load and parse brands.json from a few candidate locations. Pure-ish: only
// touches the local filesystem, never the network. Throws nothing — returns
// { clients: [] } if the file can't be found/parsed so callers stay safe.
function loadBrands(brandsPath) {
  const candidates = brandsPath
    ? [brandsPath]
    : [
        path.join(__dirname, '..', 'brands.json'),
        path.join(process.cwd(), 'brands.json'),
      ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const json = JSON.parse(raw);
      if (json && Array.isArray(json.clients)) return json;
    } catch (_) {
      // try next candidate
    }
  }
  return { clients: [] };
}

// Derive the TC commission percentage as a whole number (e.g. 10 for 10%).
function deriveTcPercent(client) {
  if (typeof client.commissionRate === 'number') {
    // commissionRate is a fraction (0.1 => 10%). If someone stored it as a
    // whole number by mistake (>1), pass it through unscaled.
    return client.commissionRate <= 1
      ? Math.round(client.commissionRate * 1000) / 10
      : client.commissionRate;
  }
  if (typeof client.gmvShare === 'number') return client.gmvShare;
  return null;
}

/**
 * resolveBrandTcContext(brandId, [brandsPath])
 * @param {string} brandId  brand id, referralCode, or name
 * @param {string} [brandsPath] optional explicit path to brands.json (for tests)
 * @returns {{found:true, shopId:(number|null), productName:string, tcPercent:(number|null), openCollabEnabled:boolean} | {found:false}}
 */
function resolveBrandTcContext(brandId, brandsPath) {
  if (brandId === undefined || brandId === null || brandId === '') {
    return { found: false };
  }
  const { clients } = loadBrands(brandsPath);
  if (!clients.length) return { found: false };

  const target = slugify(brandId);
  const client = clients.find((c) => {
    return (
      slugify(c.id) === target ||
      slugify(c.referralCode) === target ||
      slugify(c.name) === target
    );
  });

  if (!client) return { found: false };

  return {
    found: true,
    shopId: typeof client.shopId === 'number' ? client.shopId : null,
    // No structured product field exists in brands.json; the brand name is the
    // most reliable TC product label. Honest fallback, never fabricated.
    productName: client.name || null,
    tcPercent: deriveTcPercent(client),
    openCollabEnabled: client.openCollabEnabled === true,
  };
}

module.exports = { resolveBrandTcContext, slugify, loadBrands, deriveTcPercent };
