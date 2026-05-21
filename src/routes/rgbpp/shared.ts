import { FastifyInstance } from 'fastify';
import { CKBTransaction, IsomorphicTransaction } from './types';
import { Transaction as BTCTransaction } from '../bitcoin/types';
import { TransactionWithStatus } from '../../services/ckb';

/**
 * Create a getIsomorphicTx function with the specified rgbpp lock detection behavior.
 * @param fastify - The Fastify instance
 * @param includeOutputOnlyRgbpp - When true (v2), accept transactions with rgbpp lock only in outputs.
 *                                  When false (v1), require rgbpp lock in inputs.
 */
export function createGetIsomorphicTx(fastify: FastifyInstance, includeOutputOnlyRgbpp?: boolean) {
  return async function getIsomorphicTx(btcTx: BTCTransaction) {
    const isomorphicTx: IsomorphicTransaction = {
      ckbVirtualTx: undefined,
      ckbTx: undefined,
      status: { confirmed: false },
    };
    const setCkbTxAndStatus = (tx: TransactionWithStatus) => {
      isomorphicTx.ckbTx = CKBTransaction.parse(tx.transaction);
      isomorphicTx.status.confirmed = tx.txStatus.status === 'committed';
    };

    const job = await fastify.transactionProcessor.getTransactionRequest(btcTx.txid);
    if (job) {
      const { ckbRawTx } = job.data.ckbVirtualResult;
      isomorphicTx.ckbVirtualTx = ckbRawTx;
      // if the job is completed, get the ckb tx hash and fetch the ckb tx
      const state = await job.getState();
      if (state === 'completed') {
        const ckbTx = await fastify.ckb.rpc.getTransaction(job.returnvalue);
        // remove ckbRawTx to reduce response size
        isomorphicTx.ckbVirtualTx = undefined;
        setCkbTxAndStatus(ckbTx);
      }
      return isomorphicTx;
    }
    const rgbppLockTx = await fastify.rgbppCollector.queryRgbppLockTxByBtcTx(btcTx, includeOutputOnlyRgbpp);
    if (rgbppLockTx) {
      const ckbTx = await fastify.ckb.rpc.getTransaction(rgbppLockTx.txHash);
      setCkbTxAndStatus(ckbTx);
    } else {
      const btcTimeLockTx = await fastify.rgbppCollector.queryBtcTimeLockTxByBtcTx(btcTx);
      if (btcTimeLockTx) {
        setCkbTxAndStatus(btcTimeLockTx);
      }
    }
    return isomorphicTx;
  };
}
