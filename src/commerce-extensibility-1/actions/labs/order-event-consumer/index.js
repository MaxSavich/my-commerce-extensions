const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const DEFAULT_SCOPES =
  'openid,AdobeID,email,profile,additional_info.roles,additional_info.projectedProductContext,commerce.accs';

function normalizeScopeTokens (scopeStr) {
  return String(scopeStr)
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

function resolveImsScopeParam (raw, defaultScopes) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return normalizeScopeTokens(defaultScopes);
  }
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean).join(' ');
  }
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t).trim()).filter(Boolean).join(' ');
      }
    } catch {
      /* fall through */
    }
  }
  return normalizeScopeTokens(s);
}

let cachedToken = null;
let cachedExpiryMs = 0;

async function getImsAccessToken (params) {
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) {
    return cachedToken;
  }
  const body = new URLSearchParams({
    client_id: params.IMS_OAUTH_S2S_CLIENT_ID,
    client_secret: params.IMS_OAUTH_S2S_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: resolveImsScopeParam(params.IMS_OAUTH_S2S_SCOPES, DEFAULT_SCOPES),
  });
  const res = await fetch(IMS_TOKEN_URL, {
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

async function main (params) {
  const logger = Core.Logger('order-event-consumer', {
    level: params.LOG_LEVEL || 'info',
  });

  try {
    const eventId = params.event_id;
    const eventData = params.data?.value || params.event?.data || {};
    const eventType = params.type || params.event_type || 'unknown';

    logger.info(`Event received: ${eventType}, ID: ${eventId}`);

    const state = await stateLib.init();
    const existing = await state.get(`event-${eventId}`);
    if (existing && existing.value) {
      logger.info(`Event ${eventId} already processed, skipping`);
      return {
        statusCode: 200,
        body: { message: 'Event already processed', eventId },
      };
    }

    const orderId = eventData.entity_id
      || eventData.increment_id
      || eventData.id;

    if (!orderId) {
      logger.warn('No order ID found in event payload');
      return {
        statusCode: 200,
        body: { message: 'No order ID in payload, skipping', eventId },
      };
    }

    logger.info(`Processing order: ${orderId}`);

    const baseUrl = params.COMMERCE_API_BASE_URL.replace(/\/$/, '');
    const accessToken = await getImsAccessToken(params);

    const orderUrl = `${baseUrl}/V1/orders/${encodeURIComponent(orderId)}`;

    const orderResponse = await fetch(
      orderUrl,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
          'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!orderResponse.ok) {
      logger.error(`Commerce API returned ${orderResponse.status} for order ${orderId}`);
      return {
        statusCode: 500,
        body: { error: `Failed to fetch order ${orderId}` },
      };
    }

    const order = await orderResponse.json();

    const enrichedOrder = {
      orderId: order.entity_id,
      incrementId: order.increment_id,
      status: order.status,
      customerEmail: order.customer_email,
      grandTotal: order.grand_total,
      currency: order.order_currency_code,
      itemCount: order.items?.length || 0,
      processedAt: new Date().toISOString(),
      enrichment: {
        orderTier: classifyOrderTier(order.grand_total),
        isHighValue: parseFloat(order.grand_total) >= 500,
        itemSummary: (order.items || []).map((item) => ({
          sku: item.sku,
          name: item.name,
          qty: item.qty_ordered,
        })),
      },
    };

    logger.info('Enriched order:', JSON.stringify(enrichedOrder));

    await state.put(`order-${orderId}`, JSON.stringify(enrichedOrder), {
      ttl: 604800,
    });

    await state.put(`event-${eventId}`, JSON.stringify({ processedAt: new Date().toISOString() }), {
      ttl: 86400,
    });

    logger.info(`Successfully processed event ${eventId} for order ${orderId}`);

    return {
      statusCode: 200,
      body: {
        message: 'Event processed successfully',
        eventId,
        orderId,
        orderTier: enrichedOrder.enrichment.orderTier,
      },
    };
  } catch (error) {
    logger.error('Event processing failed:', error.message, error.stack);
    return {
      statusCode: 500,
      body: { error: 'Event processing failed' },
    };
  }
}

function classifyOrderTier (grandTotal) {
  const total = parseFloat(grandTotal);
  if (total >= 1000) return 'platinum';
  if (total >= 500) return 'gold';
  if (total >= 100) return 'silver';
  return 'bronze';
}

exports.main = main;
