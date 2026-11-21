import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BlockbookClient } from '../../src/services/bitcoin/blockbook';
import type { Transaction } from '../../src/services/bitcoin/schema';

const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const cursor = hash(501);
const cursorBlock = hash(50_000);
const height = 500;
const time = 1_800_000_000;
const status = { confirmed: true, block_height: height, block_hash: cursorBlock, block_time: time };
const blockbookTx = (txid: string, extra?: object) => ({
  txid,
  blockHeight: height,
  blockHash: cursorBlock,
  blockTime: time,
  confirmations: 42,
  ...extra,
});
const transaction = (txid: string, confirmed = true): Transaction => ({
  txid,
  version: 2,
  locktime: 0,
  vin: [],
  vout: [],
  size: 180,
  weight: 600,
  fee: 100,
  status: confirmed ? status : { confirmed },
});
const reply = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({
  config,
  status,
  statusText: String(status),
  headers: {},
  data,
});

describe('Blockbook history and transaction status', () => {
  const originalAdapter = axios.defaults.adapter;
  const adapter = vi.fn();
  const createClient = () => new BlockbookClient('http://blockbook.test/prefix');

  beforeEach(() => {
    adapter.mockReset();
    axios.defaults.adapter = adapter;
  });
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  test.each([true, false])(
    'first page caps pending at 50 and confirmed at 25; modern combined page: %s',
    async (combined) => {
      const pending = Array.from({ length: 80 }, (_, index) => hash(index + 1_000));
      const confirmed = Array.from({ length: 80 }, (_, index) => hash(index + 2_000));
      adapter.mockImplementation(async (config) => {
        const { page, pageSize, details, to } = config.params;
        expect(config.url).toBe('/api/v2/address/' + address);
        expect({ page, details }).toEqual({ page: 1, details: 'txids' });
        if (to === undefined) {
          expect(pageSize).toBe(75);
          return reply(config, {
            page,
            itemsOnPage: pageSize,
            totalPages: 2,
            unconfirmedTxs: pending.length,
            txs: confirmed.length,
            txids: combined ? pending.slice(0, pageSize) : [...pending, ...confirmed.slice(0, pageSize)],
          });
        }
        expect({ to, pageSize }).toEqual({ to: 0xffffffff, pageSize: 25 });
        return reply(config, {
          page,
          itemsOnPage: pageSize,
          totalPages: -1,
          unconfirmedTxs: 0,
          txs: confirmed.length,
          txids: confirmed.slice(0, pageSize),
        });
      });
      let active = 0;
      let maximum = 0;
      const hydrate = vi.fn(async (txid: string) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return transaction(txid, confirmed.includes(txid));
      });
      const result = await createClient().getAddressTxs({ address }, hydrate);
      expect(result.map(({ txid }) => txid)).toEqual([...pending.slice(0, 50), ...confirmed.slice(0, 25)]);
      expect(hydrate).toHaveBeenCalledTimes(75);
      expect(maximum).toBe(8);
      expect(adapter).toHaveBeenCalledTimes(combined ? 2 : 1);
    },
  );

  test('returns unused address history without hydrating anything', async () => {
    adapter.mockImplementation(async (config) =>
      reply(config, { page: 1, itemsOnPage: 75, totalPages: 1, txs: 0, unconfirmedTxs: 0 }),
    );
    const hydrate = vi.fn();
    await expect(createClient().getAddressTxs({ address }, hydrate)).resolves.toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
  });

  function historyFixture(sameBlock: string[], older: string[], changeBlock = false) {
    adapter.mockImplementation(async (config) => {
      if (config.url === '/api/v2/tx/' + cursor) return reply(config, blockbookTx(cursor));
      if (config.url === '/api/v2/block-index/' + height) {
        return reply(config, { blockHash: changeBlock ? hash(50_001) : cursorBlock });
      }
      expect(config.url).toBe('/api/v2/address/' + address);
      const { details, page, pageSize, to, from } = config.params;
      expect(details).toBe('txids');
      const rows = to === height ? sameBlock : older;
      expect(to === height ? from : to).toBe(to === height ? height : height - 1);
      const cappedPage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
      return reply(config, {
        page: cappedPage,
        itemsOnPage: pageSize,
        totalPages: -1,
        txs: sameBlock.length + older.length,
        unconfirmedTxs: 0,
        txids: rows.slice((cappedPage - 1) * pageSize, cappedPage * pageSize),
      });
    });
  }

  test('cursors keep all later same-block txs across a page boundary and fill from older blocks', async () => {
    const sameBlock = [...Array.from({ length: 999 }, (_, i) => hash(4_000 + i)), cursor, hash(9_000), hash(9_001)];
    const older = Array.from({ length: 30 }, (_, i) => hash(10_000 + i));
    historyFixture(sameBlock, older);
    const hydrate = vi.fn(async (txid: string) => transaction(txid));
    const result = await createClient().getAddressTxs({ address, after_txid: cursor }, hydrate);
    expect(result.map(({ txid }) => txid)).toEqual([...sameBlock.slice(-2), ...older.slice(0, 23)]);
    expect(hydrate).toHaveBeenCalledTimes(25);
    expect(hydrate).not.toHaveBeenCalledWith(cursor);
    expect(adapter.mock.calls.slice(1, 4).map(([config]) => config.params)).toEqual([
      { details: 'txids', page: 1, pageSize: 1000, from: height, to: height },
      { details: 'txids', page: 2, pageSize: 1000, from: height, to: height },
      { details: 'txids', page: 1, pageSize: 23, to: height - 1 },
    ]);
  });

  test('recognizes legacy clamped paging at an exactly-full final page and returns end of history', async () => {
    historyFixture([...Array.from({ length: 999 }, (_, i) => hash(4_000 + i)), cursor], []);
    const hydrate = vi.fn();
    await expect(createClient().getAddressTxs({ address, after_txid: cursor }, hydrate)).resolves.toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
    expect(adapter).toHaveBeenCalledTimes(5);
  });

  test('refuses to substitute another address history for an unrelated cursor', async () => {
    historyFixture([hash(604)], [hash(605)]);
    const hydrate = vi.fn();
    await expect(createClient().getAddressTxs({ address, after_txid: cursor }, hydrate)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('does not belong'),
    });
    expect(hydrate).not.toHaveBeenCalled();
    expect(adapter.mock.calls.some(([config]) => config.params?.to === height - 1)).toBe(false);
  });

  test('does not hydrate on a cursor reorg', async () => {
    historyFixture([cursor, hash(604)], [hash(605)], true);
    const hydrate = vi.fn();
    await expect(createClient().getAddressTxs({ address, after_txid: cursor }, hydrate)).rejects.toThrow(
      'cursor block changed',
    );
    expect(hydrate).not.toHaveBeenCalled();
  });

  test('distinguishes genuine missing transaction from operational 400/404', async () => {
    adapter.mockImplementationOnce(async (config) => reply(config, blockbookTx(cursor)));
    adapter.mockImplementationOnce(async (config) =>
      reply(config, blockbookTx(cursor, { confirmations: 0, blockTime: time, blockHeight: -1, blockHash: undefined })),
    );
    for (const status of [400, 404]) {
      adapter.mockImplementationOnce(async (config) => {
        throw new AxiosError(
          'missing',
          undefined,
          config,
          undefined,
          reply(
            config,
            {
              error: `Transaction '${cursor}' not found`,
            },
            status,
          ),
        );
      });
    }
    adapter.mockImplementationOnce(async (config) => {
      throw new AxiosError(
        'operational outage',
        undefined,
        config,
        undefined,
        reply(
          config,
          {
            error: `Transaction '${cursor}' not found (backend unavailable)`,
          },
          400,
        ),
      );
    });
    const book = createClient();
    await expect(book.getTransactionStatus(cursor)).resolves.toEqual(status);
    await expect(book.getTransactionStatus(cursor)).resolves.toEqual({ confirmed: false });
    await expect(book.getTransactionStatus(cursor)).resolves.toBeUndefined();
    await expect(book.getTransactionStatus(cursor)).resolves.toBeUndefined();
    await expect(book.getTransactionStatus(cursor)).rejects.toThrow('operational outage');
  });
});
