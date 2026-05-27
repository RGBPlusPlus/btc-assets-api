import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import validateBitcoinAddress from '../../utils/validators';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { IsomorphicTransaction, Script } from './types';
import { createActivityHandler } from './shared';
import z from 'zod';
import { Transaction as BTCTransaction } from '../bitcoin/types';

const addressRoutesV2: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  fastify.addHook('preHandler', async (request) => {
    const { btc_address } = request.params as { btc_address: string };
    const valid = validateBitcoinAddress(btc_address);
    if (!valid) {
      throw fastify.httpErrors.badRequest('Invalid bitcoin address');
    }
  });

  // v2: include output-only rgbpp lock transactions
  const handleActivity = createActivityHandler(fastify, true);

  fastify.get(
    '/:btc_address/activity',
    {
      schema: {
        description: 'Get RGB++ activity by btc address, including output-only rgbpp lock transactions',
        tags: ['RGB++ V2'],
        params: z.object({
          btc_address: z.string(),
        }),
        querystring: z.object({
          type_script: Script.or(z.string())
            .describe(
              `
              type script to filter cells

              two ways to provide:
              - as a object: 'encodeURIComponent(JSON.stringify({"codeHash":"0x...", "args":"0x...", "hashType":"type"}))'
              - as a hex string: '0x...' (You can pack by @ckb-lumos/codec blockchain.Script.pack({ "codeHash": "0x...", ... }))
            `,
            )
            .optional(),
          rgbpp_only: z
            .enum(['true', 'false'])
            .default('false')
            .describe('Whether to get RGB++ only activity, default is false'),
          after_btc_txid: z.string().optional().describe('Get activity after this btc txid'),
        }),
        response: {
          200: z.object({
            address: z.string(),
            txs: z.array(
              z
                .object({
                  btcTx: BTCTransaction,
                })
                .and(
                  z.union([
                    z.object({
                      isRgbpp: z.literal(true),
                      isomorphicTx: IsomorphicTransaction,
                    }),
                    z.object({ isRgbpp: z.literal(false) }),
                  ]),
                ),
            ),
            cursor: z.string().optional(),
          }),
        },
      },
    },
    async (request) => {
      const { btc_address } = request.params;
      const { rgbpp_only, after_btc_txid, type_script } = request.query;
      return handleActivity({ btc_address, rgbpp_only, after_btc_txid, type_script });
    },
  );

  done();
};

export default addressRoutesV2;
