import { FastifyPluginCallback } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server } from 'http';
import z from 'zod';
import { CUSTOM_HEADERS } from '../../constants';

const transactionRouteV2: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  fastify.get(
    '/:btc_txid',
    {
      schema: {
        description: 'Get the CKB transaction hash by BTC txid, including output-only rgbpp lock transactions',
        tags: ['RGB++ V2'],
        params: z.object({
          btc_txid: z.string().length(64, 'should be a 64-character hex string'),
        }),
        response: {
          200: z.object({
            txhash: z.string().describe('The CKB transaction hash'),
          }),
        },
      },
    },
    async (request, reply) => {
      const { btc_txid } = request.params;
      // get the transaction hash from the job if it exists
      const job = await fastify.transactionProcessor.getTransactionRequest(btc_txid);
      if (job?.returnvalue) {
        return { txhash: job.returnvalue };
      }

      const btcTx = await fastify.bitcoin.getTx({ txid: btc_txid });
      // v2: include output-only rgbpp lock transactions
      const rgbppLockTx = await fastify.rgbppCollector.queryRgbppLockTxByBtcTx(btcTx, true);
      if (rgbppLockTx) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
        return { txhash: rgbppLockTx.txHash };
      }
      const btcTimeLockTx = await fastify.rgbppCollector.queryBtcTimeLockTxByBtcTx(btcTx);
      if (btcTimeLockTx) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
        return { txhash: btcTimeLockTx.transaction.hash };
      }

      reply.status(404);
    },
  );

  done();
};

export default transactionRouteV2;
