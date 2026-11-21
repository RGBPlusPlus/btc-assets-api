import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { bitcoin } from '@rgbpp-sdk/btc';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BitcoinCoreClient } from '../../src/services/bitcoin/core';

const txid = 'a'.repeat(64);
const parentTxid = 'ab'.repeat(32);
const blockHash = 'c'.repeat(64);
const previous = 'd'.repeat(64);
const rawHeader = 'fe'.repeat(80);
const p2w = '0014' + '11'.repeat(20);
const opReturn = '6a20' + 'ee'.repeat(32);
const taproot = '5120' + 'ff'.repeat(32);

const output = (n: number, value: number, hex = p2w, type = 'witness_v0_keyhash') => ({
  n,
  value,
  scriptPubKey: { hex, type, ...(hex === p2w && { address: 'example-address' }) },
});
const header = { hash: blockHash, confirmations: 5, height: 123, time: 1_700_000_000 };
const tx = {
  txid,
  version: 2,
  locktime: 122,
  size: 234,
  weight: 510,
  vin: [
    {
      txid: parentTxid,
      vout: 0,
      scriptSig: { hex: '0101' },
      txinwitness: ['00', '', 'aa'],
      sequence: 0xfffffffd,
      prevout: output(0, 0.00001234),
    },
  ],
  vout: [output(0, 0, opReturn, 'nulldata'), output(1, 0.00001233, taproot, 'witness_v1_taproot')],
};

type RpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
};
const request = (config: InternalAxiosRequestConfig) => JSON.parse(config.data) as RpcRequest;
const reply = (config: InternalAxiosRequestConfig, result: unknown) => ({
  config,
  data: { jsonrpc: '2.0', id: request(config).id, result },
  status: 200,
  statusText: 'OK',
  headers: {},
});

describe('Bitcoin Core RPC adapter', () => {
  const create = () =>
    new BitcoinCoreClient({
      url: 'http://core.test/rpc/',
      username: 'test-user',
      password: 'test-password',
      timeoutMs: 4_000,
    });
  const originalAdapter = axios.defaults.adapter;
  const adapter = vi.fn();
  const calls = () =>
    adapter.mock.calls.map(([config]) => {
      const { method, params } = request(config);
      return [method, params];
    });
  beforeEach(() => {
    adapter.mockReset();
    axios.defaults.adapter = adapter;
  });
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  test('maps canonical confirmed transaction metadata, exact satoshis, witness, and Esplora script output', async () => {
    adapter.mockImplementation(async (config) =>
      reply(
        config,
        request(config).method === 'getblockheader'
          ? header
          : { ...tx, blockhash: blockHash, confirmations: 5, fee: 0.00000001 },
      ),
    );
    const got = await create().getTx({ txid });
    expect(calls()).toEqual([
      ['getrawtransaction', [txid, 2]],
      ['getblockheader', [blockHash, true]],
    ]);
    expect(got.status).toEqual({ confirmed: true, block_height: 123, block_hash: blockHash, block_time: header.time });
    expect(got.fee).toBe(1);
    expect(got.vin[0]).toMatchObject({
      txid: parentTxid,
      vout: 0,
      sequence: 0xfffffffd,
      is_coinbase: false,
      scriptsig: '0101',
      scriptsig_asm: 'OP_PUSHBYTES_1 01',
      witness: ['00', '', 'aa'],
      prevout: {
        scriptpubkey: p2w,
        scriptpubkey_type: 'v0_p2wpkh',
        scriptpubkey_address: 'example-address',
        value: 1234,
      },
    });
    expect(got.vout).toEqual([
      {
        scriptpubkey: opReturn,
        scriptpubkey_type: 'op_return',
        scriptpubkey_asm: 'OP_RETURN OP_PUSHBYTES_32 ' + 'ee'.repeat(32),
        value: 0,
      },
      {
        scriptpubkey: taproot,
        scriptpubkey_type: 'v1_p2tr',
        scriptpubkey_asm: 'OP_PUSHNUM_1 OP_PUSHBYTES_32 ' + 'ff'.repeat(32),
        value: 1233,
      },
    ]);
    expect(adapter.mock.calls[0][0]).toMatchObject({
      method: 'post',
      url: 'http://core.test/rpc/',
      timeout: 4_000,
      maxRedirects: 0,
      proxy: false,
      auth: { username: 'test-user', password: 'test-password' },
    });
  });

  test('recovers absent mempool/undo prevouts with one parent RPC per distinct transaction, and computes fee', async () => {
    const normalInput = { txid: parentTxid, vout: 0, scriptSig: { hex: '' }, sequence: 1 };
    adapter.mockImplementation(async (config) => {
      const [hash] = request(config).params;
      return reply(
        config,
        hash === txid
          ? { ...tx, vin: [normalInput, { ...normalInput, vout: 1 }] }
          : { txid: parentTxid, vout: [output(0, 0.000012), output(1, 0.00000034)] },
      );
    });
    const got = await create().getTx({ txid });
    expect(calls()).toEqual([
      ['getrawtransaction', [txid, 2]],
      ['getrawtransaction', [parentTxid, 1]],
    ]);
    expect(got.vin.map((input) => input.prevout?.value)).toEqual([1200, 34]);
    expect(got.fee).toBe(1);
    expect(got.status).toEqual({ confirmed: false });
  });

  test('does not fabricate missing prevouts or a zero fee', async () => {
    adapter.mockImplementation(async (config) => {
      const [hash] = request(config).params;
      return reply(
        config,
        hash === txid
          ? { ...tx, vin: [{ ...tx.vin[0], prevout: undefined, vout: 9 }] }
          : { txid: parentTxid, vout: [output(0, 1)] },
      );
    });
    await expect(create().getTx({ txid })).rejects.toMatchObject({ statusCode: 503 });
  });

  test('maps coinbase fields and a precise large value, and does not mark a reorged block confirmed', async () => {
    adapter.mockImplementation(async (config) =>
      reply(
        config,
        request(config).method === 'getblockheader'
          ? { ...header, confirmations: -1 }
          : {
              ...tx,
              blockhash: blockHash,
              confirmations: 1,
              vin: [{ coinbase: '020102', sequence: 0xffffffff, txinwitness: ['00'.repeat(32)] }],
              vout: [output(0, 20_999_999.99999999)],
            },
      ),
    );
    const got = await create().getTx({ txid });
    expect(got.vin).toEqual([
      {
        txid: '0'.repeat(64),
        vout: 0xffffffff,
        is_coinbase: true,
        prevout: null,
        scriptsig: '020102',
        scriptsig_asm: 'OP_PUSHBYTES_2 0102',
        sequence: 0xffffffff,
        witness: ['00'.repeat(32)],
      },
    ]);
    expect(got).toMatchObject({ status: { confirmed: false }, fee: 0 });
    expect(got.vout[0].value).toBe(2_099_999_999_999_999);
  });

  test('handles Core’s explicit genesis coinbase exclusion without fake confirmations', async () => {
    const genesis = {
      ...tx,
      hex: 'beef',
      vin: [{ coinbase: '020102', sequence: 0xffffffff }],
      vout: [output(0, 50)],
      fee: 0,
    };
    adapter.mockImplementation(async (config) => {
      switch (request(config).method) {
        case 'getrawtransaction':
          return {
            ...reply(config, undefined),
            data: {
              id: request(config).id,
              error: { code: -5, message: 'The genesis block coinbase transaction cannot be retrieved' },
            },
          };
        case 'getblockhash':
          return reply(config, blockHash);
        case 'getblock':
          return reply(config, { ...header, tx: [genesis] });
        case 'getblockheader':
          return reply(config, { ...header, height: 0 });
      }
    });
    const core = create();
    await expect(core.getTxHex({ txid })).resolves.toBe('beef');
    await expect(core.getTx({ txid })).resolves.toMatchObject({ status: { confirmed: true, block_height: 0 }, fee: 0 });
  });

  test('maps block metadata and preserves the full block transaction order, raw header and tip', async () => {
    const block = {
      ...header,
      version: 536870912,
      mediantime: 100,
      nonce: 200,
      bits: '1d00ffff',
      difficulty: 1,
      merkleroot: txid,
      previousblockhash: previous,
      nTx: 3,
      size: 777,
      weight: 1222,
      tx: [parentTxid, txid, previous],
    };
    adapter.mockImplementation(async (config) => {
      switch (request(config).method) {
        case 'getblock':
          return reply(config, block);
        case 'getblockheader':
          return reply(config, rawHeader);
        case 'getbestblockhash':
        case 'getblockhash':
          return reply(config, blockHash);
        case 'getrawtransaction':
          return reply(config, 'aabb');
      }
    });
    const core = create();
    await expect(core.getBlock({ hash: blockHash })).resolves.toMatchObject({
      id: blockHash,
      height: 123,
      timestamp: header.time,
      tx_count: 3,
      bits: 486604799,
      previousblockhash: previous,
    });
    await expect(core.getBlockTxids({ hash: blockHash })).resolves.toEqual([parentTxid, txid, previous]);
    await expect(core.getBlockHeight({ height: 123 })).resolves.toBe(blockHash);
    await expect(core.getBlocksTipHash()).resolves.toBe(blockHash);
    await expect(core.getBlockHeader({ hash: blockHash })).resolves.toBe(rawHeader);
    await expect(core.getTxHex({ txid })).resolves.toBe('aabb');
    expect(calls()).toEqual([
      ['getblock', [blockHash, 1]],
      ['getblock', [blockHash, 1]],
      ['getblockhash', [123]],
      ['getbestblockhash', []],
      ['getblockheader', [blockHash, false]],
      ['getrawtransaction', [txid, 0]],
    ]);
  });

  test('estimates sat/vB in monotonic order and falls back to the Core mempool floor', async () => {
    const rates: Record<number, number> = { 2: 0.00002001, 6: 0.00003901, 144: 0.000001 };
    adapter.mockImplementation(async (config) => {
      const { method, params } = request(config);
      const rate = rates[params[0] as number];
      return reply(
        config,
        method === 'getmempoolinfo'
          ? { mempoolminfee: 0.00000201, minrelaytxfee: 0.000001 }
          : rate === undefined
            ? { errors: ['Insufficient data or no feerate found'] }
            : { feerate: rate },
      );
    });
    await expect(create().getFeesRecommended()).resolves.toEqual({
      fastestFee: 4,
      halfHourFee: 4,
      hourFee: 4,
      economyFee: 0.3,
      minimumFee: 0.3,
    });
    expect(calls().slice(1)).toEqual([2, 3, 6, 144].map((target) => ['estimatesmartfee', [target, 'economical']]));
  });

  test.each([false, true])(
    'gets the exact input index for a real decoded synthetic spender, confirmed=%s',
    async (confirmed) => {
      const spending = new bitcoin.Transaction();
      spending.addInput(Buffer.from(prevoutHash(previous)), 2);
      spending.addInput(Buffer.from(prevoutHash(parentTxid)), 3);
      spending.addOutput(Buffer.from(p2w, 'hex'), 1000);
      adapter.mockImplementation(async (config) =>
        reply(
          config,
          request(config).method === 'getblockheader'
            ? header
            : [
                {
                  txid: parentTxid,
                  vout: 3,
                  spendingtxid: spending.getId(),
                  spendingtx: spending.toHex(),
                  ...(confirmed && { blockhash: blockHash }),
                },
              ],
        ),
      );
      await expect(create().getTxOutspend({ txid: parentTxid.toUpperCase(), vout: 3 })).resolves.toEqual({
        spent: true,
        txid: spending.getId(),
        vout: 1,
        status: confirmed
          ? { confirmed: true, block_height: 123, block_hash: blockHash, block_time: header.time }
          : { confirmed: false },
      });
      expect(calls()[0]).toEqual([
        'gettxspendingprevout',
        [[{ txid: parentTxid, vout: 3 }], { mempool_only: false, return_spending_tx: true }],
      ]);
    },
  );

  test('distinguishes a valid unspent outpoint from an absent output', async () => {
    adapter.mockImplementation(async (config) => {
      const { method, params } = request(config);
      return reply(
        config,
        method === 'gettxspendingprevout' ? params[0] : { txid, vout: [output(0, 0, opReturn, 'nulldata')] },
      );
    });
    const core = create();
    await expect(core.getTxOutspend({ txid, vout: 0 })).resolves.toEqual({ spent: false });
    await expect(core.getTxOutspend({ txid, vout: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('requires a loaded, synced archive node and both indexes', async () => {
    let synced = false;
    adapter.mockImplementation(async (config) => {
      switch (request(config).method) {
        case 'getblockchaininfo':
          return reply(config, { initialblockdownload: false, pruned: false });
        case 'getindexinfo':
          return reply(config, { txindex: { synced: true }, txospenderindex: { synced } });
        case 'getmempoolinfo':
          return reply(config, { loaded: true });
      }
    });
    const core = create();
    await expect(core.checkReady()).rejects.toMatchObject({ statusCode: 503 });
    synced = true;
    await expect(core.checkReady()).resolves.toBeUndefined();
  });

  test('broadcasts only once to the mocked Core and does not expose its raw error message', async () => {
    adapter
      .mockImplementationOnce(async (config) => reply(config, txid))
      .mockImplementationOnce(async (config) => ({
        ...reply(config, null),
        data: { id: request(config).id, error: { code: -26, message: 'private backend detail' } },
      }));
    const core = create();
    await expect(core.postTx({ txhex: 'deadbeef' })).resolves.toBe(txid);
    await expect(core.postTx({ txhex: 'beef' })).rejects.toMatchObject({
      statusCode: 400,
      code: -26,
      message: 'Bitcoin Core rejected the transaction (RPC -26)',
    });
    expect(calls()).toEqual([
      ['sendrawtransaction', ['deadbeef']],
      ['sendrawtransaction', ['beef']],
    ]);
  });

  test('sanitizes RPC, transport, credential, and redirect errors', async () => {
    adapter
      .mockImplementationOnce(async (config) => ({
        ...reply(config, txid),
        status: 302,
        headers: { location: 'http://elsewhere.test' },
      }))
      .mockRejectedValueOnce(new AxiosError('private error', 'ETIMEDOUT'))
      .mockImplementationOnce(async (config) => ({
        ...reply(config, null),
        status: 401,
        data: 'private error',
      }))
      .mockImplementationOnce(async (config) => ({
        ...reply(config, undefined),
        data: { id: request(config).id, error: { code: -5, message: 'unknown tx private data' } },
      }));
    const core = create();
    await expect(core.getBlockHeight({ height: 0 })).rejects.toMatchObject({
      statusCode: 503,
      message: 'Bitcoin Core RPC unavailable',
    });
    await expect(core.getBlockHeight({ height: 0 })).rejects.toMatchObject({ statusCode: 504 });
    await expect(core.getBlockHeight({ height: 0 })).rejects.toMatchObject({
      statusCode: 503,
      message: 'Bitcoin Core RPC authentication failed',
    });
    await expect(core.getTx({ txid })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Bitcoin Core could not find the requested data',
    });
    expect(() => new BitcoinCoreClient({ url: 'http://someone:private@core.test/' })).toThrow(
      /without embedded credentials/,
    );
  });
});

function prevoutHash(hash: string) {
  return Buffer.from(hash, 'hex').reverse();
}
