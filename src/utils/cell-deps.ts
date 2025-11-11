import { CKBRawTransaction, CellDep } from '../routes/rgbpp/types';

/**
 * Check and add cell dependency if needed
 * @param ckbRawTx - the CKB raw transaction to modify
 * @param latestCellDep - the latest cell dependency to add
 * @param required - whether the dependency is required
 * @returns true if the dependency was added, false otherwise
 */
export function addLatestCellDepIfNeeded(
  ckbRawTx: CKBRawTransaction,
  latestCellDep: CellDep,
  required: boolean,
): boolean {
  if (!required) {
    return false;
  }

  if (!latestCellDep) {
    throw new Error('Cell dependency is required but not provided');
  }

  // Check if cell dep already exists to avoid duplicates
  const hasLatestDep = ckbRawTx.cellDeps.some(
    (dep) =>
      dep.outPoint?.txHash === latestCellDep.outPoint?.txHash &&
      dep.outPoint?.index === latestCellDep.outPoint?.index &&
      dep.depType === latestCellDep.depType,
  );

  if (!hasLatestDep) {
    if (!latestCellDep.outPoint) {
      throw new Error('Cell dependency missing outPoint - cannot repair transaction');
    }

    ckbRawTx.cellDeps.unshift(latestCellDep, {
      ...latestCellDep,
      outPoint: { ...latestCellDep.outPoint, index: '0x1' },
    } as CellDep);

    return true;
  }

  return false;
}
