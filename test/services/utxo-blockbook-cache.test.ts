import { describe, expect, test, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Cradle } from '../../src/container';
import UTXOSyncer from '../../src/services/utxo';

vi.mock('../../src/services/base/queue-worker', () => ({ default: class {} }));

const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const snapshot = (value: number) => [{ txid: 'a'.repeat(64), vout: 0, value, status: { confirmed: false } }];
const job = { data: { btcAddress: address } } as Job<{ btcAddress: string }>;

function fakeCache() {
  const values = new Map<string, string>();
  return {
    values,
    redis: {
      get: vi.fn(async (key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
    },
  };
}

function buildSyncer(cache: ReturnType<typeof fakeCache>, blockbookUrl?: string) {
  const getAddressTxsUtxo = vi.fn(async () => snapshot(10));
  const getAddressTxs = vi.fn(async () => []);
  const syncer = new UTXOSyncer({
    env: {
      NETWORK: 'testnet',
      BITCOIN_BLOCKBOOK_API_URL: blockbookUrl,
      UTXO_SYNC_DATA_CACHE_ENABLE: true,
      SENTRY_IGNORE_UTXO_SYNC_ERROR_ADDRESSES: [],
    },
    redis: cache.redis,
    bitcoin: { getAddressTxsUtxo, getAddressTxs },
    logger: { info: vi.fn(), error: vi.fn() },
  } as unknown as Cradle);
  return { syncer, getAddressTxsUtxo, getAddressTxs };
}

describe('Blockbook UTXO cache', () => {
  test('refreshes from UTXOs even when address history is unchanged, and handles spent-to-empty', async () => {
    const cache = fakeCache();
    const { syncer, getAddressTxsUtxo, getAddressTxs } = buildSyncer(cache, 'http://blockbook.test');
    getAddressTxsUtxo.mockResolvedValueOnce(snapshot(10)).mockResolvedValueOnce(snapshot(20)).mockResolvedValueOnce([]);

    await syncer.process(job);
    expect(await syncer.getUtxosByAddress(address)).toEqual(snapshot(10));
    await syncer.process(job);
    expect(await syncer.getUtxosByAddress(address)).toEqual(snapshot(20));
    await syncer.process(job);
    expect(await syncer.getUtxosByAddress(address)).toEqual([]);
    expect(getAddressTxs).not.toHaveBeenCalled();
    expect(getAddressTxsUtxo).toHaveBeenCalledTimes(3);
  });

  test('does not reuse cache from legacy or a different Blockbook endpoint', async () => {
    const cache = fakeCache();
    const legacy = buildSyncer(cache);
    const old = buildSyncer(cache, 'http://blockbook-old.test');
    const current = buildSyncer(cache, 'http://blockbook-current.test');
    await legacy.syncer.process(job);
    await old.syncer.process(job);
    current.getAddressTxsUtxo.mockResolvedValueOnce(snapshot(25));
    expect(await current.syncer.getUtxosByAddress(address)).toEqual(snapshot(25));
    expect(current.getAddressTxsUtxo).toHaveBeenCalledOnce();
  });

  test('a failed refresh preserves the previous cached snapshot', async () => {
    const cache = fakeCache();
    const { syncer, getAddressTxsUtxo } = buildSyncer(cache, 'http://blockbook.test');
    await syncer.process(job);
    getAddressTxsUtxo.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(syncer.process(job)).rejects.toThrow('source unavailable');
    expect(await syncer.getUtxosByAddress(address)).toEqual(snapshot(10));
  });

  test('retains unchanged history optimization on legacy providers', async () => {
    const cache = fakeCache();
    const { syncer, getAddressTxsUtxo, getAddressTxs } = buildSyncer(cache);
    await syncer.process(job);
    await syncer.process(job);
    expect(getAddressTxs).toHaveBeenCalledTimes(2);
    expect(getAddressTxsUtxo).toHaveBeenCalledOnce();
  });
});
