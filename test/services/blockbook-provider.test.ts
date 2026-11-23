import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Cradle } from '../../src/container';
import { NetworkType } from '../../src/constants';
import BitcoinClient, { BitcoinClientAPIError } from '../../src/services/bitcoin';
import { BlockbookHistoryError, BlockbookHistoryLimitError } from '../../src/services/bitcoin/blockbook';
import { BitcoinCoreRPCError } from '../../src/services/bitcoin/core';

const testnet3 = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const testnet4 = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const txid = 'd'.repeat(64);
const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const calls = vi.hoisted(() => ({
  core: vi.fn(),
  getBaseURL: vi.fn(),
  getFeesRecommended: vi.fn(),
  getBlockHeight: vi.fn(),
  getBlocksTipHash: vi.fn(),
  getBlock: vi.fn(),
  getBlockHeader: vi.fn(),
  getBlockTxids: vi.fn(),
  getTx: vi.fn(),
  getTxHex: vi.fn(),
  getTxOutspend: vi.fn(),
  postTx: vi.fn(),
  checkReady: vi.fn(),
  blockbook: vi.fn(),
  getGenesisHash: vi.fn(),
  getAddressTxs: vi.fn(),
  getAddressTxsUtxo: vi.fn(),
  getTransactionStatus: vi.fn(),
}));

vi.mock('../../src/services/bitcoin/core', () => {
  class MockBitcoinCoreRPCError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  }
  return {
    BitcoinCoreRPCError: MockBitcoinCoreRPCError,
    BitcoinCoreClient: class {
      constructor(config: unknown) {
        calls.core(config);
      }
      getBaseURL = calls.getBaseURL;
      getFeesRecommended = calls.getFeesRecommended;
      getBlockHeight = calls.getBlockHeight;
      getBlocksTipHash = calls.getBlocksTipHash;
      getBlock = calls.getBlock;
      getBlockHeader = calls.getBlockHeader;
      getBlockTxids = calls.getBlockTxids;
      getTx = calls.getTx;
      getTxHex = calls.getTxHex;
      getTxOutspend = calls.getTxOutspend;
      postTx = calls.postTx;
      checkReady = calls.checkReady;
    },
  };
});

vi.mock('../../src/services/bitcoin/blockbook', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/bitcoin/blockbook')>();
  return {
    ...original,
    BlockbookClient: class {
      constructor(url: string) {
        calls.blockbook(url);
      }
      getGenesisHash = calls.getGenesisHash;
      getAddressTxs = calls.getAddressTxs;
      getAddressTxsUtxo = calls.getAddressTxsUtxo;
      getTransactionStatus = calls.getTransactionStatus;
    },
  };
});

vi.mock('../../src/services/bitcoin/electrs', () => ({
  ElectrsClient: class {
    constructor() {
      throw new Error('Full Blockbook mode must not construct Electrs');
    }
  },
}));
vi.mock('../../src/services/bitcoin/mempool', () => ({
  MempoolClient: class {
    constructor() {
      throw new Error('Full Blockbook mode must not construct Mempool');
    }
  },
}));

const makeClient = () =>
  new BitcoinClient({
    env: {
      BITCOIN_DATA_PROVIDER: 'blockbook',
      BITCOIN_BLOCKBOOK_API_URL: 'http://blockbook.test:19130',
      BITCOIN_CORE_RPC_URL: 'http://core.test:18332',
      BITCOIN_CORE_RPC_USERNAME: 'rpc',
      BITCOIN_CORE_RPC_PASSWORD: 'unit-test',
      BITCOIN_ADDITIONAL_BROADCAST_ELECTRS_URL_LIST: ['https://legacy.test'],
    },
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as Cradle);

describe('Full Blockbook/Core backend routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('routes each method without constructing legacy providers or broadcast backupers', async () => {
    const client = makeClient();
    expect(calls.blockbook).toHaveBeenCalledWith('http://blockbook.test:19130');
    expect(calls.core).toHaveBeenCalledWith({
      url: 'http://core.test:18332',
      username: 'rpc',
      password: 'unit-test',
    });

    calls.getAddressTxs.mockImplementation(async (_, hydrate) => [await hydrate(txid)]);
    calls.getTx.mockResolvedValue({ txid });
    calls.postTx.mockResolvedValue(txid);
    await expect(client.getAddressTxs({ address, after_txid: txid })).resolves.toEqual([{ txid }]);
    expect(calls.getAddressTxs).toHaveBeenCalledWith({ address, after_txid: txid }, expect.any(Function));
    expect(calls.getTx).toHaveBeenCalledWith({ txid });
    await client.getAddressTxsUtxo({ address });
    expect(calls.getAddressTxsUtxo).toHaveBeenCalledWith({ address });
    await client.getBlockbookTransactionStatus(txid);
    expect(calls.getTransactionStatus).toHaveBeenCalledWith(txid);

    await client.getFeesRecommended();
    await client.getBlocksTipHash();
    await client.getBlock({ hash: testnet3 });
    await client.getBlockTxids({ hash: testnet3 });
    await client.getBlockHeader({ hash: testnet3 });
    await client.getTxHex({ txid });
    await client.getTxOutspend({ txid, vout: 2 });
    await expect(client.postTx({ txhex: 'abcd' })).resolves.toBe(txid);
    expect(calls.getFeesRecommended).toHaveBeenCalledOnce();
    expect(calls.getBlocksTipHash).toHaveBeenCalledOnce();
    expect(calls.getBlock).toHaveBeenCalledWith({ hash: testnet3 });
    expect(calls.getBlockTxids).toHaveBeenCalledWith({ hash: testnet3 });
    expect(calls.getBlockHeader).toHaveBeenCalledWith({ hash: testnet3 });
    expect(calls.getTxHex).toHaveBeenCalledWith({ txid });
    expect(calls.getTxOutspend).toHaveBeenCalledWith({ txid, vout: 2 });
    expect(calls.postTx).toHaveBeenCalledOnce();
    expect(calls.postTx).toHaveBeenCalledWith({ txhex: 'abcd' });
  });

  test('validates both backends against the configured genesis and delegates readiness to Core', async () => {
    const client = makeClient();
    calls.getBlockHeight.mockResolvedValue(testnet3);
    calls.getGenesisHash.mockResolvedValueOnce(testnet3).mockResolvedValueOnce(testnet4);
    await expect(client.checkNetwork(NetworkType.testnet)).resolves.toBeUndefined();
    await expect(client.checkNetwork(NetworkType.testnet)).rejects.toThrow('Blockbook is not running');
    expect(calls.getBlockHeight).toHaveBeenCalledWith({ height: 0 });

    calls.checkReady.mockRejectedValueOnce(new Error('index is syncing'));
    await expect(client.checkCoreReady()).rejects.toThrow('index is syncing');
  });

  test('preserves the API error class and status for a Core transaction-not-found', async () => {
    const client = makeClient();
    calls.getTx.mockRejectedValueOnce(
      Object.assign(Object.create(BitcoinCoreRPCError.prototype), { message: 'not found', statusCode: 404 }),
    );
    const error = await client.getTx({ txid }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BitcoinClientAPIError);
    expect(error).toMatchObject({ statusCode: 404, message: 'not found' });
  });

  test.each([
    new BlockbookHistoryLimitError(),
    new BlockbookHistoryError('Bitcoin address history changed during pagination; restart from the first page'),
  ])('preserves the explanation when Blockbook cannot continue pending address history: %s', async (error) => {
    const client = makeClient();
    calls.getAddressTxs.mockRejectedValueOnce(error);
    await expect(client.getAddressTxs({ address, after_txid: txid })).rejects.toMatchObject({
      statusCode: 503,
      message: error.message,
    });
  });
});
