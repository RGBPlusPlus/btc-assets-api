import type { IBitcoinDataProvider } from './interface';
import { BitcoinCoreClient, BitcoinCoreRPCError } from './core';
import type { BlockbookClient } from './blockbook';

/** Blockbook indexes addresses; Core supplies canonical blocks, transaction data and broadcasting. */
export function blockbookCoreProvider(core: BitcoinCoreClient, blockbook: BlockbookClient): IBitcoinDataProvider {
  return {
    getBaseURL: () => core.getBaseURL(),
    getFeesRecommended: () => core.getFeesRecommended(),
    postTx: (params) => core.postTx(params),
    getAddressTxsUtxo: (params) => blockbook.getAddressTxsUtxo(params),
    getAddressTxs: (params) =>
      blockbook.getAddressTxs(params, async (txid) => {
        try {
          return await core.getTx({ txid });
        } catch (err) {
          if (err instanceof BitcoinCoreRPCError && err.statusCode === 404) {
            throw new Error('Blockbook history and Bitcoin Core disagree on a transaction; retry');
          }
          throw err;
        }
      }),
    getTx: (params) => core.getTx(params),
    getTxHex: (params) => core.getTxHex(params),
    getBlock: (params) => core.getBlock(params),
    getBlockHeight: (params) => core.getBlockHeight(params),
    getBlockHeader: (params) => core.getBlockHeader(params),
    getBlockTxids: (params) => core.getBlockTxids(params),
    getBlocksTipHash: () => core.getBlocksTipHash(),
    getTxOutspend: (params) => core.getTxOutspend(params),
  };
}
