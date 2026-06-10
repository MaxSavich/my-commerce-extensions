const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

// Utility (not part of the course): read a key (or list keys) from I/O State
// to verify what order-event-consumer wrote in Activity 4-2.
async function main (params) {
  const logger = Core.Logger('state-read', { level: params.LOG_LEVEL || 'info' });
  try {
    const state = await stateLib.init();

    // If a key is provided, return that single value.
    if (params.key) {
      const res = await state.get(params.key);
      return {
        statusCode: 200,
        body: {
          key: params.key,
          found: !!(res && res.value),
          value: res && res.value ? safeParse(res.value) : null,
          expiration: res ? res.expiration : null,
        },
      };
    }

    // Otherwise, list keys (optionally filtered by `match` glob, default order-*).
    const match = params.match || 'order-*';
    const keys = [];
    const iterator = state.list({ match });
    for await (const { keys: batch } of iterator) {
      keys.push(...batch);
    }
    return {
      statusCode: 200,
      body: { match, count: keys.length, keys },
    };
  } catch (error) {
    logger.error('state-read failed:', error.message);
    return { statusCode: 500, body: { error: error.message } };
  }
}

function safeParse (v) {
  try { return JSON.parse(v); } catch { return v; }
}

exports.main = main;
