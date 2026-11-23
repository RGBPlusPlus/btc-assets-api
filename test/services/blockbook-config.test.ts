import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function unsetEnv(key: string) {
  vi.stubEnv(key, '');
  delete process.env[key];
}

function stubBlockbookEnv() {
  vi.stubEnv('BITCOIN_DATA_PROVIDER', 'blockbook');
  unsetEnv('BITCOIN_ELECTRS_API_URL');
  unsetEnv('BITCOIN_MEMPOOL_SPACE_API_URL');
  vi.stubEnv('BITCOIN_BLOCKBOOK_API_URL', 'http://blockbook.test:19130');
  vi.stubEnv('BITCOIN_CORE_RPC_URL', 'http://core.test:18332');
  unsetEnv('BITCOIN_CORE_RPC_USERNAME');
  unsetEnv('BITCOIN_CORE_RPC_PASSWORD');
}

describe('Blockbook provider configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    stubBlockbookEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('requires no legacy service and omits RPC credentials from logged env', async () => {
    vi.stubEnv('BITCOIN_CORE_RPC_USERNAME', 'rpc');
    vi.stubEnv('BITCOIN_CORE_RPC_PASSWORD', 'secret');
    const { env, getSafeEnvs } = await import('../../src/env');
    expect(env).toMatchObject({
      BITCOIN_DATA_PROVIDER: 'blockbook',
      BITCOIN_BLOCKBOOK_API_URL: 'http://blockbook.test:19130',
    });
    expect(getSafeEnvs()).not.toHaveProperty('BITCOIN_CORE_RPC_PASSWORD');
    expect(getSafeEnvs()).not.toHaveProperty('BITCOIN_CORE_RPC_USERNAME');
    expect(getSafeEnvs()).not.toHaveProperty('BITCOIN_CORE_RPC_URL');
  });

  test('requires both services and complete HTTP Basic credential pairs', async () => {
    vi.stubEnv('BITCOIN_CORE_RPC_USERNAME', 'rpc');
    await expect(import('../../src/env')).rejects.toThrow('Set both Bitcoin Core RPC username and password');
    vi.resetModules();
    vi.stubEnv('BITCOIN_CORE_RPC_PASSWORD', 'secret');
    unsetEnv('BITCOIN_BLOCKBOOK_API_URL');
    await expect(import('../../src/env')).rejects.toThrow();
  });

  test('rejects credentials embedded in the Core RPC URL', async () => {
    vi.stubEnv('BITCOIN_CORE_RPC_URL', 'http://user:secret@core.test:18332');
    await expect(import('../../src/env')).rejects.toThrow('Use separate Bitcoin Core RPC credentials');
  });
});
