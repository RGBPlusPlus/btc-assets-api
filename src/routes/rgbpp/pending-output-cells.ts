import { groupBy } from 'lodash';
import pLimit from 'p-limit';
import { buildPreLockArgs } from '@rgbpp-sdk/ckb';
import type { Cell } from './types';
import type { UTXO } from '../../services/bitcoin/schema';

const limitLookup = pLimit(8);

const isRecent = (time: number | undefined, now: number) => time !== undefined && time > 0 && now - time < 20 * 60;

interface PendingOutputLookups {
  getPendingOutputCells: (txid: string) => Promise<Cell[]>;
  getTransactionStatus?: (txid: string) => Promise<UTXO['status'] | undefined>;
}

export async function getPendingOutputCells(
  utxos: UTXO[],
  now: number,
  { getPendingOutputCells, getTransactionStatus }: PendingOutputLookups,
): Promise<Cell[]> {
  // Blockbook omits block_time. For those confirmed outputs, look up pending CKB jobs first
  // and fetch transaction timestamps only when a matching pending cell actually exists.
  const candidates = utxos.filter(
    ({ status }) =>
      !status.confirmed ||
      isRecent(status.block_time, now) ||
      (getTransactionStatus !== undefined && status.block_time === undefined),
  );
  const cells = await Promise.all(
    Object.entries(groupBy(candidates, 'txid')).map(([txid, outputs]) => {
      const findMatches = async () => {
        const knownArgs = new Set(
          outputs
            .filter(({ status }) => !status.confirmed || status.block_time !== undefined)
            .map(({ vout }) => buildPreLockArgs(vout)),
        );
        const allArgs = new Set(outputs.map(({ vout }) => buildPreLockArgs(vout)));
        const matches = (await getPendingOutputCells(txid)).filter((cell) => allArgs.has(cell.cellOutput.lock.args));
        if (!getTransactionStatus || matches.every((cell) => knownArgs.has(cell.cellOutput.lock.args))) {
          return matches;
        }

        const status = await getTransactionStatus(txid);
        // A missing transaction at the same provider is a temporary disagreement, not an address 404.
        return status && (!status.confirmed || isRecent(status.block_time, now))
          ? matches
          : matches.filter((cell) => knownArgs.has(cell.cellOutput.lock.args));
      };
      return getTransactionStatus ? limitLookup(findMatches) : findMatches();
    }),
  );
  return cells.flat();
}
