import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep suites that start Fastify against real services or exercise Redis out of CI.
    // The default Vitest config still runs those suites when backends are configured.
    include: [
      'test/utils/**/*.test.ts',
      'test/startup.test.ts',
      'test/plugins/public-api-auth.test.ts',
      'test/routes/internal-auth.test.ts',
      'test/routes/rgbpp/activity-cursor.test.ts',
      'test/routes/rgbpp/pending-output-cells.test.ts',
      'test/services/bitcoin.test.ts',
      'test/services/blockbook-config.test.ts',
      'test/services/blockbook-history.test.ts',
      'test/services/blockbook-provider.test.ts',
      'test/services/blockbook.test.ts',
      'test/services/core.test.ts',
      'test/services/spv.test.ts',
      'test/services/unlocker.test.ts',
      'test/services/utxo-blockbook-cache.test.ts',
    ],
    env: {
      // Satisfy the app schema without pointing at any real backend.
      NETWORK: 'testnet',
      REDIS_URL: 'redis://redis.invalid',
      JWT_SECRET: 'unit-test-only',
      BITCOIN_DATA_PROVIDER: 'electrs',
      BITCOIN_ELECTRS_API_URL: 'https://electrs.invalid',
      BITCOIN_SPV_SERVICE_URL: 'https://spv.invalid',
      CKB_RPC_URL: 'https://ckb.invalid',
      PAYMASTER_PRIVATE_KEY: 'unit-test-only',
    },
  },
});
