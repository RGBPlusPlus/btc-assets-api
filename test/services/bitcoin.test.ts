import type { Cradle } from '../../src/container';
import pino from 'pino';
import { describe, test, beforeEach, expect, vi } from 'vitest';
import BitcoinClient, { BitcoinClientAPIError } from '../../src/services/bitcoin';
import { ElectrsClient } from '../../src/services/bitcoin/electrs';
import { MempoolClient } from '../../src/services/bitcoin/mempool';
import { AxiosError } from 'axios';

describe.each(['mempool', 'electrs'] as const)('BitcoinClient (%s)', (provider) => {
  let bitcoin: BitcoinClient;

  let cradle: Cradle;

  beforeEach(() => {
    cradle = {
      logger: pino({ enabled: false }),
      env: {
        NETWORK: 'testnet',
        BITCOIN_DATA_PROVIDER: provider,
        BITCOIN_METHODS_USE_ELECTRS_BY_DEFAULT: [],
        BITCOIN_MEMPOOL_SPACE_API_URL: 'https://mempool.invalid',
        BITCOIN_ELECTRS_API_URL: 'https://electrs.invalid',
      },
    } as unknown as Cradle;
    bitcoin = new BitcoinClient(cradle);
  });

  test('BitcoinClient: Should be use data providers', async () => {
    if (cradle.env.BITCOIN_DATA_PROVIDER === 'mempool') {
      expect(bitcoin['source'].constructor).toBe(MempoolClient);
      expect(bitcoin['fallback']?.constructor).toBe(ElectrsClient);
    } else {
      expect(bitcoin['source'].constructor).toBe(ElectrsClient);
      expect(bitcoin['fallback']?.constructor).toBe(MempoolClient);
    }
  });

  if (provider === 'mempool') {
    test('BitcoinClient: Should be use Electrs as default data provider for methods', async () => {
      if (cradle.env.BITCOIN_DATA_PROVIDER !== 'mempool') throw new Error('Expected mempool provider');
      cradle.env.BITCOIN_METHODS_USE_ELECTRS_BY_DEFAULT = ['getAddressTxs'];
      bitcoin = new BitcoinClient(cradle);
      expect(bitcoin['source'].constructor).toBe(MempoolClient);
      expect(bitcoin['fallback']?.constructor).toBe(ElectrsClient);

      // @ts-expect-error just for test, so we don't need to check the return value
      const mempoolFn = vi.spyOn(bitcoin['source']!, 'getAddressTxs').mockResolvedValue([{}]);
      const electrsFn = vi.spyOn(bitcoin['fallback']!, 'getAddressTxs').mockResolvedValue([]);
      expect(await bitcoin.getAddressTxs({ address: 'test' })).toEqual([]);
      expect(mempoolFn).not.toHaveBeenCalled();
      expect(electrsFn).toHaveBeenCalled();
    });
  }

  test('BitcoinClient: throw BitcoinClientError when source provider failed', async () => {
    bitcoin['fallback'] = undefined;
    vi.spyOn(bitcoin['source'], 'postTx').mockRejectedValue(new AxiosError('source provider error'));
    await expect(bitcoin.postTx({ txhex: 'test' })).rejects.toBeInstanceOf(BitcoinClientAPIError);
    await expect(bitcoin.postTx({ txhex: 'test' })).rejects.toThrowError('source provider error');
  });

  test('BitcoinClient: throw BitcoinClientError when fallback provider failed', async () => {
    vi.spyOn(bitcoin['source'], 'postTx').mockRejectedValue(new AxiosError('source provider error'));
    vi.spyOn(bitcoin['fallback']!, 'postTx').mockRejectedValue(new AxiosError('fallback provider error'));
    await expect(bitcoin.postTx({ txhex: 'test' })).rejects.toBeInstanceOf(BitcoinClientAPIError);
    await expect(bitcoin.postTx({ txhex: 'test' })).rejects.toThrowError('fallback provider error');
  });
});
