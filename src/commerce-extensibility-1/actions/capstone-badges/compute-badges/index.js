const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

// ---------------------------------------------------------------------------
// Capstone: compute-badges
// Reads a product from the Commerce API, applies the badge rules, and writes
// the resulting badge state to I/O State under key `badge:<sku>`.
//
// Badge rules (final, per SESSION_CAPSTONE_PLAN.md):
//   new        -> product created_at within `newWithinDays` (default 30)
//   bestseller -> sku present in merchant-configured `bestsellerSkus[]`
//   limited    -> active special_price within special_from/to_date window
//
// Rules are read from I/O State key `badge-rules`; if absent, DEFAULT_RULES
// is used (overridable later via the Week 5 Admin UI).
// ---------------------------------------------------------------------------

const DEFAULT_RULES = {
  newWithinDays: 30,
  bestsellerSkus: ['BPG-5005'],
};

const BADGE_STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let cachedToken = null;
let cachedExpiryMs = 0;

function normalizeImsTokenUrl(raw) {
  const fallback = 'https://ims-na1.adobelogin.com/ims/token/v2';
  if (!raw || typeof raw !== 'string') return fallback;
  const u = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/;+\s*$/g, '')
    .trim();
  return u || fallback;
}

/** IMS expects `scope` as comma-separated names, not a JSON array string. */
function scopeFormValue(scopesParam) {
  if (scopesParam == null) return '';
  const s = String(scopesParam).trim();
  if (!s.startsWith('[')) return s;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter(Boolean).join(',') : s;
  } catch {
    return s;
  }
}

async function getImsAccessToken(params) {
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) {
    return cachedToken;
  }
  const tokenUrl = normalizeImsTokenUrl(params.IMS_TOKEN_URL);
  const scope = scopeFormValue(params.IMS_OAUTH_S2S_SCOPES);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(params.IMS_OAUTH_S2S_CLIENT_ID || ''),
    client_secret: String(params.IMS_OAUTH_S2S_CLIENT_SECRET || ''),
    org_id: String(params.IMS_OAUTH_S2S_ORG_ID || ''),
    scope,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IMS token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiryMs = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/** SaaS (ACCS) uses `/V1/products/{sku}`; on-prem Magento uses `/rest/{store}/V1/...`. */
function catalogProductUrl(baseUrl, sku, p) {
  const b = String(baseUrl).replace(/\/$/, '');
  const encodedSku = encodeURIComponent(sku);
  if (/api\.commerce\.adobe\.com/i.test(b)) {
    return `${b}/V1/products/${encodedSku}`;
  }
  const storeCode = (p && p.COMMERCE_STORE_CODE) || 'default';
  return `${b}/rest/${encodeURIComponent(storeCode)}/V1/products/${encodedSku}`;
}

/** Read a product field, checking top-level then the custom_attributes array. */
function getAttr(product, code) {
  if (product == null) return undefined;
  if (product[code] !== undefined) return product[code];
  const ca = Array.isArray(product.custom_attributes) ? product.custom_attributes : [];
  const found = ca.find((a) => a && a.attribute_code === code);
  return found ? found.value : undefined;
}

/** Parse a Commerce datetime string ("2026-05-01 12:00:00") as UTC ms. */
function parseCommerceDate(raw) {
  if (!raw) return NaN;
  return new Date(`${String(raw).trim().replace(' ', 'T')}Z`).getTime();
}

function computeBadges(product, rules, sku) {
  const badges = [];

  // NEW
  const createdMs = parseCommerceDate(product.created_at);
  if (!Number.isNaN(createdMs)) {
    const ageDays = (Date.now() - createdMs) / 86_400_000;
    if (ageDays <= (rules.newWithinDays ?? 30)) badges.push('new');
  }

  // BEST SELLER (merchant-configured SKU list)
  const bestsellerSkus = Array.isArray(rules.bestsellerSkus) ? rules.bestsellerSkus : [];
  if (bestsellerSkus.includes(sku)) badges.push('bestseller');

  // LIMITED OFFER (active special_price window)
  const specialPrice = parseFloat(getAttr(product, 'special_price'));
  if (!Number.isNaN(specialPrice) && specialPrice > 0) {
    const now = Date.now();
    const fromMs = parseCommerceDate(getAttr(product, 'special_from_date'));
    const toMs = parseCommerceDate(getAttr(product, 'special_to_date'));
    const fromOk = Number.isNaN(fromMs) || fromMs <= now;
    const toOk = Number.isNaN(toMs) || toMs >= now;
    if (fromOk && toOk) badges.push('limited');
  }

  return badges;
}

async function loadRules(state, logger) {
  try {
    const res = await state.get('badge-rules');
    if (res && res.value) {
      const parsed = JSON.parse(res.value);
      return { ...DEFAULT_RULES, ...parsed };
    }
  } catch (e) {
    logger.warn(`badge-rules not loaded, using defaults: ${e.message}`);
  }
  return DEFAULT_RULES;
}

async function main(params) {
  const logger = Core.Logger('compute-badges', { level: params.LOG_LEVEL || 'info' });

  try {
    const { sku } = params;
    if (!sku) {
      return { statusCode: 400, body: { error: 'Missing required parameter: sku' } };
    }
    const rawBase = params.COMMERCE_API_BASE_URL;
    if (!rawBase || typeof rawBase !== 'string') {
      return { statusCode: 400, body: { error: 'Missing COMMERCE_API_BASE_URL' } };
    }

    const baseUrl = rawBase.replace(/\/$/, '');
    const accessToken = await getImsAccessToken(params);
    const productUrl = catalogProductUrl(baseUrl, sku, params);

    logger.info(`Fetching product for badge computation: ${sku}`);
    const response = await fetch(productUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
        'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error(`Commerce API ${response.status} ${productUrl}`);
      return {
        statusCode: response.status,
        body: { error: `Commerce API error: ${response.statusText}`, url: productUrl },
      };
    }

    const product = await response.json();

    const state = await stateLib.init();
    const rules = await loadRules(state, logger);
    const badges = computeBadges(product, rules, sku);

    const value = { sku, badges, updatedAt: new Date().toISOString() };
    await state.put(`badge_${sku}`, JSON.stringify(value), { ttl: BADGE_STATE_TTL_SECONDS });

    logger.info(`Computed badges for ${sku}: ${badges.join(', ') || '(none)'}`);
    return { statusCode: 200, body: value };
  } catch (error) {
    logger.error('compute-badges failed:', error.message);
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
