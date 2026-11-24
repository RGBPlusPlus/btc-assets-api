import { describe, expect, it, vi } from 'vitest';
import type { Cradle } from '../../src/container';
import CKBClient from '../../src/services/ckb';

const tx = (txHash: string, blockNumber: string, txIndex: string, ioType = 'output') =>
  ({ txHash, blockNumber, txIndex, ioType }) as const;

function setup() {
  const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
  const ckb = new CKBClient({ env: { CKB_RPC_URL: 'https://ckb.invalid' }, redis } as unknown as Cradle);
  const getTransactions = vi.fn();
  const createBatchRequest = vi.fn((calls: string[][]) => ({
    exec: async () => calls.map(([, hash]) => ({ transaction: { hash } })),
  }));
  ckb.rpc = { getTransactions, createBatchRequest } as unknown as typeof ckb.rpc;
  return { ckb, redis, getTransactions, createBatchRequest };
}

describe('CKB metadata transaction lookup', () => {
  it('paginates both scripts and deduplicates outputs while keeping chain order', async () => {
    const { ckb, getTransactions, createBatchRequest, redis } = setup();
    getTransactions
      .mockResolvedValueOnce({ objects: [tx('second', '0x1', '0x2')], lastCursor: 'page1' })
      .mockResolvedValueOnce({
        objects: [tx('second', '0x1', '0x2'), tx('skip', '0x2', '0x0', 'input')],
        lastCursor: 'page2',
      })
      .mockResolvedValueOnce({ objects: [] })
      .mockResolvedValueOnce({ objects: [tx('first', '0x1', '0x1')], lastCursor: 'page1' })
      .mockResolvedValueOnce({ objects: [] });

    await expect(ckb.getAllInfoCellTxs()).resolves.toEqual(
      ['first', 'second'].map((hash) => ({ transaction: { hash } })),
    );
    expect(getTransactions.mock.calls.map((args) => args[3])).toEqual([
      undefined,
      'page1',
      'page2',
      undefined,
      'page1',
    ]);
    expect(getTransactions.mock.calls.every((args) => args[2] === '0x3e8')).toBe(true);
    expect(createBatchRequest).toHaveBeenCalledWith([
      ['getTransaction', 'first'],
      ['getTransaction', 'second'],
    ]);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('does not request an empty RPC batch when there is no metadata', async () => {
    const { ckb, getTransactions, createBatchRequest, redis } = setup();
    getTransactions.mockResolvedValue({ objects: [] });
    await expect(ckb.getAllInfoCellTxs()).resolves.toEqual([]);
    expect(createBatchRequest).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('propagates indexer errors without caching them as empty results', async () => {
    const { ckb, getTransactions, redis } = setup();
    const error = new Error('CKB indexer is unavailable');
    getTransactions.mockRejectedValue(error);
    await expect(ckb.getAllInfoCellTxs()).rejects.toBe(error);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a nonadvancing indexer cursor without caching a partial result', async () => {
    const { ckb, getTransactions, redis } = setup();
    getTransactions.mockResolvedValue({ objects: [tx('first', '0x1', '0x1')], lastCursor: 'page1' });
    await expect(ckb.getAllInfoCellTxs()).rejects.toThrow('cursor did not advance');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched transaction results without caching incomplete metadata', async () => {
    const { ckb, getTransactions, createBatchRequest, redis } = setup();
    getTransactions
      .mockResolvedValueOnce({ objects: [tx('first', '0x1', '0x1')], lastCursor: 'page1' })
      .mockResolvedValue({ objects: [] });
    createBatchRequest.mockReturnValueOnce({ exec: async () => [{ transaction: { hash: 'other' } }] });
    await expect(ckb.getAllInfoCellTxs()).rejects.toThrow('incomplete metadata transaction batch');
    expect(redis.set).not.toHaveBeenCalled();
  });
});
