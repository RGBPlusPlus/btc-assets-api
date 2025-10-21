import healthcheck from 'fastify-custom-healthcheck';
import fp from 'fastify-plugin';
import TransactionProcessor from '../services/transaction';
import Paymaster from '../services/paymaster';
import axios from 'axios';
import { Env } from '../env';
import { withTimeout } from '../utils/timeout';

export default fp(async (fastify) => {
  const env: Env = fastify.container.resolve('env');
  const timeout = env.HEALTHCHECK_TIMEOUT_MS;

  await fastify.register(healthcheck, {
    path: '/healthcheck',
    exposeFailure: true,
    schema: false,
  });

  fastify.addHealthCheck('redis', async () => {
    const redis = fastify.container.resolve('redis');
    await withTimeout(redis.ping(), timeout, 'healthcheck:redis');
  });

  fastify.addHealthCheck('btcDataSource', async () => {
    const electrsUrl = env.BITCOIN_ELECTRS_API_URL ? `${env.BITCOIN_ELECTRS_API_URL}/blocks/tip/height` : null;

    const networkPath = env.NETWORK === 'mainnet' ? '' : `/${env.NETWORK}`;
    const mempoolUrl = env.BITCOIN_MEMPOOL_SPACE_API_URL
      ? `${env.BITCOIN_MEMPOOL_SPACE_API_URL}${networkPath}/api/blocks/tip/height`
      : null;

    const isElectrs = env.BITCOIN_DATA_PROVIDER === 'electrs';
    const primaryUrl = isElectrs ? electrsUrl : mempoolUrl;
    const fallbackUrl = isElectrs ? mempoolUrl : electrsUrl;

    if (!primaryUrl) {
      throw new Error(`Primary Bitcoin data source (${env.BITCOIN_DATA_PROVIDER}) is not configured`);
    }

    // Check both data sources in parallel
    // Primary is always checked, fallback is optional
    const checks: Promise<void>[] = [
      withTimeout(
        axios.get(primaryUrl),
        timeout,
        `healthcheck:btcDataSource:primary (${env.BITCOIN_DATA_PROVIDER})`,
      ).then(() => {}),
    ];
    const sourceNames: string[] = [`primary (${env.BITCOIN_DATA_PROVIDER})`];

    if (fallbackUrl) {
      checks.push(withTimeout(axios.get(fallbackUrl), timeout, `healthcheck:btcDataSource:fallback`).then(() => {}));
      sourceNames.push('fallback');
    }

    const results = await Promise.allSettled(checks);

    // Check if at least one source is healthy
    const hasHealthySource = results.some((result) => result.status === 'fulfilled');
    const errorMessages = results
      .map((result, index) => {
        if (result.status === 'rejected') {
          const error = result.reason;
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          return `${sourceNames[index]}: ${message}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('; ');

    // Only fail if all configured sources are unavailable
    if (!hasHealthySource) {
      throw new Error(`All Bitcoin data sources unavailable: ${errorMessages}`);
    }

    if (errorMessages) {
      fastify.log.warn(`BTC data sources partial failure: ${errorMessages}`);
    }
  });

  fastify.addHealthCheck('queue', async () => {
    const transactionProcessor: TransactionProcessor = fastify.container.resolve('transactionProcessor');

    await withTimeout(
      (async () => {
        const counts = await transactionProcessor.getQueueJobCounts();
        if (!counts) {
          throw new Error('Transaction queue is not available');
        }
        const isRunning = await transactionProcessor.isWorkerRunning();
        if (!isRunning) {
          throw new Error('Transaction worker is not running');
        }
      })(),
      timeout,
      'healthcheck:queue',
    );
  });

  fastify.addHealthCheck('paymaster', async () => {
    const paymaster: Paymaster = fastify.container.resolve('paymaster');

    await withTimeout(
      (async () => {
        const count = await paymaster.getPaymasterCellCount();
        if (!count) {
          throw new Error('Paymaster cell queue is empty');
        }
      })(),
      timeout,
      'healthcheck:paymaster',
    );
  });
});
