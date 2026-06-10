const { Core } = require('@adobe/aio-sdk');

async function main (params) {
  const logger = Core.Logger('validate-product', {
    level: params.LOG_LEVEL || 'info',
  });

  logger.info('Webhook received:', JSON.stringify(params));

  try {
    const product = params.product || params.data?.product;

    if (!product) {
      logger.warn('No product data in webhook payload');
      return {
        statusCode: 200,
        body: { op: 'success' },
      };
    }

    const name = product.name != null ? String(product.name) : '';
    if (name.toLowerCase().includes('invalid')) {
      const message =
        'Product validation failed: product name must not contain the word "invalid".';
      logger.warn(message);
      return {
        statusCode: 200,
        body: {
          op: 'exception',
          message,
        },
      };
    }

    logger.info(`Product ${product.sku || 'unknown'} passed validation`);
    return {
      statusCode: 200,
      body: { op: 'success' },
    };
  } catch (error) {
    logger.error('Webhook handler failed:', error.message);
    return {
      statusCode: 200,
      body: { op: 'success' },
    };
  }
}

exports.main = main;
