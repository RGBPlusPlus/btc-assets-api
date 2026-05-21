import { FastifyInstance } from 'fastify';
import { CKBTransaction, IsomorphicTransaction } from './types';
import { Transaction as BTCTransaction } from '../bitcoin/types';
import { TransactionWithStatus } from '../../services/ckb';
import { Script } from '@ckb-lumos/lumos';
import { filterOutputsByTypeScript, getTypeScript } from '../../utils/typescript';

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

/**
 * Create a reusable activity route handler.
 * @param fastify - The Fastify instance
 * @param includeOutputOnlyRgbpp - When true (v2), accept transactions with rgbpp lock only in outputs.
 */
export function createActivityHandler(fastify: FastifyInstance, includeOutputOnlyRgbpp?: boolean) {
  const getIsomorphicTx = createGetIsomorphicTx(fastify, includeOutputOnlyRgbpp);

  return async (params: {
    btc_address: string;
    rgbpp_only: string;
    after_btc_txid?: string;
    type_script?: Script | string;
  }) => {
    const { btc_address, rgbpp_only, after_btc_txid } = params;
    const typeScript = getTypeScript(params.type_script);

    const btcTxs = await fastify.bitcoin.getAddressTxs({
      address: btc_address,
      after_txid: after_btc_txid,
    });

    let txs = await Promise.all(
      btcTxs.map(async (btcTx) => {
        const isomorphicTx = await getIsomorphicTx(btcTx);
        const isRgbpp = isomorphicTx.ckbVirtualTx || isomorphicTx.ckbTx;
        if (!isRgbpp) {
          return {
            btcTx,
            isRgbpp: false,
          } as const;
        }

        const inputs = isomorphicTx.ckbVirtualTx?.inputs || isomorphicTx.ckbTx?.inputs || [];
        const outPoints = inputs
          .map((input) => input.previousOutput)
          .filter((op): op is NonNullable<typeof op> => op != null);
        const inputCells = outPoints.length > 0 ? await fastify.ckb.getInputCellsByOutPoint(outPoints) : [];
        const inputCellOutputs = inputCells.map((cell) => cell.cellOutput);

        const outputs = isomorphicTx.ckbVirtualTx?.outputs || isomorphicTx.ckbTx?.outputs || [];

        return {
          btcTx,
          isRgbpp: true,
          isomorphicTx: {
            ...isomorphicTx,
            inputs: inputCellOutputs,
            outputs,
          },
        } as const;
      }),
    );

    if (rgbpp_only === 'true') {
      txs = txs.filter((tx) => tx.isRgbpp);
    }

    if (typeScript) {
      txs = txs.filter((tx) => {
        if (!tx.isRgbpp) {
          return false;
        }
        const cells = [...tx.isomorphicTx.inputs, ...tx.isomorphicTx.outputs];
        return filterOutputsByTypeScript(cells, typeScript).length > 0;
      });
    }

    const cursor = btcTxs.length > 0 ? btcTxs[btcTxs.length - 1].txid : undefined;
    return {
      address: btc_address,
      txs,
      cursor,
    };
  };
}
