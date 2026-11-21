import { buildPreLockArgs } from '@rgbpp-sdk/ckb';
import type { Cell } from '../../../src/routes/rgbpp/types';
import { describe, expect, test, vi } from 'vitest';
import { getPendingOutputCells } from '../../../src/routes/rgbpp/pending-output-cells';
import type { UTXO } from '../../../src/services/bitcoin/schema';

const utxo = (txid: string, vout: number, status: UTXO['status']): UTXO => ({ txid, vout, value: 1, status });
const cell = (index: number) => ({ cellOutput: { lock: { args: buildPreLockArgs(index) } } }) as Cell;
const confirmed = { confirmed: true };
const now = 2_000;

describe('RGB++ pending output detection', () => {
  test('checks time only for unknown timestamps with matching queued outputs', async () => {
    const unconfirmed = utxo('unconfirmed', 1, { confirmed: false });
    const knownRecent = utxo('known-recent', 2, { ...confirmed, block_time: now - 100 });
    const knownOld = utxo('known-old', 3, { ...confirmed, block_time: now - 1200 });
    const unknownRecent = utxo('unknown-recent', 4, confirmed);
    const unknownRecentSecondVout = utxo('unknown-recent', 5, confirmed);
    const unknownOld = utxo('unknown-old', 6, confirmed);
    const unknownNoJob = utxo('unknown-no-job', 7, confirmed);
    const unknownNoVout = utxo('unknown-no-vout', 8, confirmed);
    const getQueueCells = vi.fn(async (id: string) => {
      switch (id) {
        case 'unconfirmed':
          return [cell(1)];
        case 'known-recent':
          return [cell(2)];
        case 'unknown-recent':
          return [cell(4), cell(5), cell(99)];
        case 'unknown-old':
          return [cell(6)];
        case 'unknown-no-vout':
          return [cell(9)];
        default:
          return [];
      }
    });
    const getStatus = vi.fn(async (id: string) => ({
      ...confirmed,
      block_time: now - (id === 'unknown-recent' ? 100 : 1_200),
    }));

    expect(
      await getPendingOutputCells(
        [
          unconfirmed,
          knownRecent,
          knownOld,
          unknownRecent,
          unknownRecentSecondVout,
          unknownOld,
          unknownNoJob,
          unknownNoVout,
        ],
        now,
        { getPendingOutputCells: getQueueCells, getTransactionStatus: getStatus },
      ),
    ).toEqual([cell(1), cell(2), cell(4), cell(5)]);
    expect(getQueueCells.mock.calls.map(([id]) => id)).toEqual([
      'unconfirmed',
      'known-recent',
      'unknown-recent',
      'unknown-old',
      'unknown-no-job',
      'unknown-no-vout',
    ]);
    expect(getStatus.mock.calls.map(([id]) => id)).toEqual(['unknown-recent', 'unknown-old']);
  });

  test('keeps the default filter when no timestamp recovery is configured', async () => {
    const getQueueCells = vi.fn(async () => [cell(0)]);
    const inputs = [utxo('unknown', 0, confirmed)];
    await expect(getPendingOutputCells(inputs, now, { getPendingOutputCells: getQueueCells })).resolves.toEqual([]);
    expect(getQueueCells).not.toHaveBeenCalled();
  });

  test('treats vanished timestamp metadata as unresolved rather than failing the address', async () => {
    const inputs = [utxo('vanished', 0, confirmed), utxo('mempool', 0, { confirmed: false })];
    const getQueueCells = vi.fn(async () => [cell(0)]);
    const getStatus = vi.fn(async () => undefined);
    await expect(
      getPendingOutputCells(inputs, now, { getPendingOutputCells: getQueueCells, getTransactionStatus: getStatus }),
    ).resolves.toEqual([cell(0)]);
    expect(getStatus).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledWith('vanished');
  });

  test('caps concurrent queue lookups across requests', async () => {
    let running = 0;
    let maxRunning = 0;
    const getQueueCells = vi.fn(async () => {
      maxRunning = Math.max(++running, maxRunning);
      await new Promise((resolve) => setImmediate(resolve));
      --running;
      return [];
    });
    const lookups = { getPendingOutputCells: getQueueCells, getTransactionStatus: vi.fn() };
    const inputs = Array.from({ length: 20 }, (_, i) => utxo(String(i), 0, confirmed));
    await Promise.all([getPendingOutputCells(inputs, now, lookups), getPendingOutputCells(inputs, now, lookups)]);
    expect(maxRunning).toBe(8);
    expect(getQueueCells).toHaveBeenCalledTimes(40);
    expect(lookups.getTransactionStatus).not.toHaveBeenCalled();
  });
});
