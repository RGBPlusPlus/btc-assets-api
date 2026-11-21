import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import { expect, test, vi } from 'vitest';
import { createActivityHandler } from '../../../src/routes/rgbpp/shared';
import { BlockbookClient } from '../../../src/services/bitcoin/blockbook';

test('an activity cursor from pending-only history can be followed to the empty tail', async () => {
  const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
  const txid = 'a'.repeat(64);
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    let data;
    if (config.url === '/api/v2/address/' + address) {
      data = { page: 1, itemsOnPage: config.params.pageSize, totalPages: 1, txs: 0, unconfirmedTxs: 1, txids: [txid] };
    } else if (config.url === '/api/v2/tx/' + txid) {
      data = { txid, confirmations: 0 };
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
            status: { confirmed: false },
          })),
      },
      transactionProcessor: { getTransactionRequest: vi.fn() },
      rgbppCollector: { queryRgbppLockTxByBtcTx: vi.fn(), queryBtcTimeLockTxByBtcTx: vi.fn() },
    } as unknown as FastifyInstance;
    const activity = createActivityHandler(fastify, true);
    const request = { btc_address: address, rgbpp_only: 'false' };
    const first = await activity(request);
    expect(first.txs.map(({ btcTx }) => btcTx.txid)).toEqual([txid]);
    expect(first.cursor).toBe(txid);
    await expect(activity({ ...request, after_btc_txid: first.cursor })).resolves.toEqual({
      address,
      txs: [],
      cursor: undefined,
    });
  } finally {
    axios.defaults.adapter = adapter;
  }
});
