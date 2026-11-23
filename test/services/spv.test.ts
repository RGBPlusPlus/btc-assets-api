import type { Cradle } from '../../src/container';
import pino from 'pino';
import { describe, test, beforeEach, afterEach, vi, expect } from 'vitest';
import SPVClient from '../../src/services/spv';

const txid = 'ede749ecee5e607e761e4fffb6d754799498056872456a7d33abe426d7b9951c';

describe('BitcoinSPV', () => {
  let spv: SPVClient;

  beforeEach(async () => {
    spv = new SPVClient({
      logger: pino({ enabled: false }),
      env: { BITCOIN_SPV_SERVICE_URL: 'https://spv.invalid' },
      bitcoin: {
        getTx: vi.fn().mockResolvedValue({ status: { block_hash: 'fixture-block-hash' } }),
        getBlockTxids: vi.fn().mockResolvedValue([txid]),
      },
    } as unknown as Cradle);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('getTxProof: throw BitcoinSPVError', async () => {
    vi.spyOn(spv['request'], 'post').mockResolvedValue({
      data: {
        jsonrpc: '2.0',
        error: {
          code: 23102,
          message:
            'target transaction is in header#2583777 and it requires 5 confirmations, but the tip header in local storage is header#2583781',
        },
        id: 'aa1a7882-9c0a-4eaa-87e8-1ed906b957f8',
      },
    });
    await expect(spv.getTxProof(txid, 100)).rejects.toThrowErrorMatchingSnapshot();
  });

  test('getTxProof: get proof successfuly', async () => {
    vi.spyOn(spv['request'], 'post').mockResolvedValue({
      data: {
        jsonrpc: '2.0',
        result: {
          spv_client: {
            tx_hash: '0x5e570545c3ffd656199d3babd85f05377ac91b396126b166cf370e2f0edddae5',
            index: '0x1',
          },
          proof: '00000000000000',
        },
        id: 'aa1a7882-9c0a-4eaa-87e8-1ed906b957f8',
      },
    });
    const proof = await spv.getTxProof(txid, 100);
    expect(proof).toHaveProperty('spv_client');
    expect(proof).toHaveProperty('proof');
  });
});
