import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import { expect, test, vi } from 'vitest';
import { createActivityHandler } from '../../../src/routes/rgbpp/shared';
import { BlockbookClient } from '../../../src/services/bitcoin/blockbook';

const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const block = { blockHeight: 500, blockHash: hash(50_000), blockTime: 1_800_000_000 };

test.each([
  { pendingCount: 1, confirmedCount: 0, pageLengths: [1] },
  { pendingCount: 50, confirmedCount: 32, pageLengths: [75, 7] },
  { pendingCount: 100, confirmedCount: 32, pageLengths: [50, 75, 7] },
  { pendingCount: 123, confirmedCount: 32, pageLengths: [50, 50, 48, 7] },
])('activity round-trips all $pendingCount pending and $confirmedCount confirmed rows', async (fixture) => {
  const pending = Array.from({ length: fixture.pendingCount }, (_, i) => hash(40_000 - i));
  const chain = Array.from({ length: fixture.confirmedCount }, (_, i) => hash(30_000 - i));
  const history = [...pending, ...chain];
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    let data;
    if (config.url === '/api/v2/address/' + address) {
      const { pageSize, to } = config.params;
      const rows = to === undefined ? history : to >= block.blockHeight ? chain : [];
      const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
      const page = Math.min(config.params.page, totalPages);
      data = {
        page,
        itemsOnPage: pageSize,
        totalPages,
        txs: chain.length,
        unconfirmedTxs: to === undefined ? pending.length : 0,
        txids: rows.slice((page - 1) * pageSize, page * pageSize),
      };
    } else if (config.url?.startsWith('/api/v2/tx/')) {
      const txid = config.url.slice('/api/v2/tx/'.length);
      expect(history).toContain(txid);
      data = pending.includes(txid) ? { txid, confirmations: 0 } : { txid, confirmations: 1, ...block };
    } else if (config.url === '/api/v2/block-index/' + block.blockHeight) {
      data = { blockHash: block.blockHash };
    } else {
      throw new Error('Unexpected Blockbook fixture request');
    }
    return { config, data, headers: {}, status: 200, statusText: 'OK' };
  };

  try {
    const client = new BlockbookClient('http://blockbook.test');
    const fastify = {
      bitcoin: {
        getAddressTxs: (params: { address: string; after_txid?: string }) =>
          client.getAddressTxs(params, async (txid) => ({
            txid,
            version: 2,
            locktime: 0,
            vin: [],
            vout: [],
            size: 180,
            weight: 600,
            fee: 100,
            status: { confirmed: chain.includes(txid) },
          })),
      },
      transactionProcessor: { getTransactionRequest: vi.fn() },
      rgbppCollector: { queryRgbppLockTxByBtcTx: vi.fn(), queryBtcTimeLockTxByBtcTx: vi.fn() },
    } as unknown as FastifyInstance;
    const activity = createActivityHandler(fastify, true);
    const request = { btc_address: address, rgbpp_only: 'false' };
    let offset = 0;
    let cursor: string | undefined;
    for (const length of fixture.pageLengths) {
      const next = await activity({ ...request, after_btc_txid: cursor });
      expect(next.txs.map(({ btcTx }) => btcTx.txid)).toEqual(history.slice(offset, offset + length));
      offset += length;
      expect(next.cursor).toBe(history[offset - 1]);
      cursor = next.cursor;
    }
    expect(offset).toBe(history.length);
    await expect(activity({ ...request, after_btc_txid: cursor })).resolves.toEqual({
      address,
      txs: [],
      cursor: undefined,
    });
  } finally {
    axios.defaults.adapter = adapter;
  }
});
