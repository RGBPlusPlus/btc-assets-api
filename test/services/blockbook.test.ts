import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Cradle } from '../../src/container';
import { NetworkType } from '../../src/constants';
import BitcoinClient from '../../src/services/bitcoin';
import { BlockbookClient } from '../../src/services/bitcoin/blockbook';

const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const testnet3 = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const testnet4 = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const fixtures = [
  { txid: 'a'.repeat(64), vout: 0, value: '0', confirmations: 0 },
  { txid: 'b'.repeat(64), vout: 2, value: '2100000000000000', confirmations: 1, height: 42 },
];

const reply = (config: InternalAxiosRequestConfig, data: unknown) => ({
  config,
  status: 200,
  statusText: 'OK',
  headers: {},
  data,
});

describe('Blockbook UTXO routing', () => {
  const originalAdapter = axios.defaults.adapter;
  const adapter = vi.fn();
  const createBitcoin = (url?: string) =>
    new BitcoinClient({
      env: {
        BITCOIN_DATA_PROVIDER: 'electrs',
        BITCOIN_ELECTRS_API_URL: 'http://electrs.test',
        BITCOIN_MEMPOOL_SPACE_API_URL: 'https://mempool.space',
        BITCOIN_BLOCKBOOK_API_URL: url,
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as Cradle);

  beforeEach(() => {
    adapter.mockReset();
    axios.defaults.adapter = adapter;
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  test('maps satoshi values and returns all 501 UTXOs with one call', async () => {
    const lots = Array.from({ length: 499 }, (_, i) => ({
      txid: (i + 1).toString(16).padStart(64, '0'),
      vout: 0,
      value: '42',
      confirmations: 2,
      height: 41,
    }));
    adapter.mockImplementation(async (config) => reply(config, [...fixtures, ...lots]));
    const bitcoin = createBitcoin('http://blockbook.test/prefix');
    const received = await bitcoin.getAddressTxsUtxo({ address });

    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://blockbook.test/prefix',
        url: '/api/v2/utxo/' + address,
        params: { confirmed: false },
        timeout: 10_000,
      }),
    );
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(501);
    expect(received[0]).toEqual({ txid: fixtures[0].txid, vout: 0, value: 0, status: { confirmed: false } });
    expect(received[1]).toEqual({
      txid: fixtures[1].txid,
      vout: 2,
      value: 2_100_000_000_000_000,
      status: { confirmed: true, block_height: 42 },
    });
  });

  test.each(['-1', '1.5', '1e3', '2100000000000001'])('fails safely on invalid value %s', async (value) => {
    adapter.mockImplementation(async (config) => reply(config, [{ ...fixtures[0], value }]));
    await expect(createBitcoin('http://blockbook.test').getAddressTxsUtxo({ address })).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('invalid response'),
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  test('rejects confirmed UTXOs without height', async () => {
    adapter.mockImplementation(async (config) => reply(config, [{ ...fixtures[1], height: undefined }]));
    await expect(createBitcoin('http://blockbook.test').getAddressTxsUtxo({ address })).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test('an empty result is not an error', async () => {
    adapter.mockImplementation(async (config) => reply(config, []));
    await expect(createBitcoin('http://blockbook.test').getAddressTxsUtxo({ address })).resolves.toEqual([]);
  });

  test('does not hit fallback or forward a JSON error body on failure', async () => {
    adapter.mockImplementation(async (config) => {
      throw new AxiosError('upstream', undefined, config, undefined, {
        ...reply(config, { error: 'private backend response' }),
        status: 502,
      });
    });
    await expect(createBitcoin('http://blockbook.test').getAddressTxsUtxo({ address })).rejects.toMatchObject({
      statusCode: 503,
      message: 'Connection error: Blockbook UTXO lookup failed (502)',
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  test('keeps legacy UTXO calls by default and other calls even when enabled', async () => {
    adapter.mockImplementation(async (config) => reply(config, []));
    await expect(createBitcoin().getAddressTxsUtxo({ address })).resolves.toEqual([]);
    await expect(createBitcoin('http://blockbook.test').getAddressTxs({ address })).resolves.toEqual([]);
    expect(adapter.mock.calls.map(([config]) => [config.baseURL, config.url])).toEqual([
      ['http://electrs.test', '/address/' + address + '/utxo'],
      ['http://electrs.test', '/address/' + address + '/txs'],
    ]);
  });

  test.each([testnet3, testnet4])(
    'requires matching genesis hash, including testnet3 vs testnet4 (%s)',
    async (hash) => {
      adapter.mockImplementation(async (config) =>
        reply(config, config.url === '/block-height/0' ? testnet3 : { blockHash: hash }),
      );
      const verify = createBitcoin('http://blockbook.test').checkNetwork(NetworkType.testnet);
      if (hash === testnet3) {
        await expect(verify).resolves.toBeUndefined();
      } else {
        await expect(verify).rejects.toThrow('Blockbook is not running on the configured Bitcoin network');
      }
      expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/block-height/0', '/api/v2/block-index/0']);
    },
  );

  test('health requires the index and mempool to be ready', async () => {
    adapter.mockImplementationOnce(async (config) =>
      reply(config, { blockbook: { inSync: true, inSyncMempool: false } }),
    );
    adapter.mockImplementationOnce(async (config) =>
      reply(config, { blockbook: { inSync: true, inSyncMempool: true } }),
    );
    const blockbook = new BlockbookClient('http://blockbook.test');
    await expect(blockbook.checkReady()).rejects.toThrow('has not synced');
    await expect(blockbook.checkReady()).resolves.toBeUndefined();
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/api/', '/api/']);
  });
});
